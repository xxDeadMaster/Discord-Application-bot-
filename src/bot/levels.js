// Leveling: XP for chatting, voice, daily first message, QOTD answers and boosts.
// Built to stay cheap: everyone's XP lives in memory and is saved to the database in ONE batch
// about once an hour (and when the bot shuts down), so the free database can keep sleeping.
import { ChannelType, EmbedBuilder } from 'discord.js';
import {
  getLevelingConfig, getSettings, loadAllLevels, saveLevels,
} from '../db.js';
import { tzParts } from '../schedule.js';
import { client, getGuild } from './client.js';
import { COLORS, footer, truncate } from './ui.js';

const SAVE_EVERY_MS = 60 * 60 * 1000;

function todayIn(timezone, now = new Date()) {
  const p = tzParts(now, timezone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

let cfg = null;
let tz = 'America/New_York';
const members = new Map(); // userId -> { xp, tag, lastMsg, lastText, lastDaily, lastQotd, dirty }
let loaded = false;

/* ---------- Level math ---------- */

/** Total XP needed to reach a level: 20 XP for level 1, then 10 more for each level after (5L² + 15L). */
export const xpForLevel = (level) => 5 * level * level + 15 * level;

export function levelFor(xp) {
  let level = Math.max(0, Math.floor((-15 + Math.sqrt(225 + 20 * Math.max(0, xp))) / 10));
  while (xpForLevel(level + 1) <= xp) level++;
  while (level > 0 && xpForLevel(level) > xp) level--;
  return level;
}

/** { level, xp, into, needed, next } for showing progress. */
export function progress(xp) {
  const level = levelFor(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, xp, into: xp - base, needed: next - base, next };
}

/* ---------- Loading, saving ---------- */

export async function loadLevels() {
  cfg = await getLevelingConfig();
  tz = (await getSettings()).timezone || tz;
  members.clear();
  for (const r of await loadAllLevels()) {
    members.set(r.user_id, { xp: r.xp, tag: r.user_tag, lastMsg: 0, lastText: '', lastDaily: r.last_daily, lastQotd: r.last_qotd, dirty: false });
  }
  loaded = true;
  console.log(`[levels] loaded ${members.size} member(s)`);
}

/** Called after the dashboard saves the leveling settings. */
export function setLevelingConfig(next) {
  cfg = next;
}

export const levelingConfig = () => cfg;

/** Writes every changed member in one query. Returns how many were saved. */
export async function flushLevels() {
  const dirty = [...members.entries()].filter(([, m]) => m.dirty);
  if (!dirty.length) return 0;
  dirty.forEach(([, m]) => { m.dirty = false; });
  try {
    await saveLevels(dirty.map(([userId, m]) => ({ userId, tag: m.tag, xp: m.xp, lastDaily: m.lastDaily, lastQotd: m.lastQotd })));
  } catch (err) {
    dirty.forEach(([, m]) => { m.dirty = true; }); // try again next time
    throw err;
  }
  return dirty.length;
}

function entry(userId, tag) {
  let m = members.get(userId);
  if (!m) { m = { xp: 0, tag: tag || '', lastMsg: 0, lastText: '', lastDaily: null, lastQotd: null, dirty: false }; members.set(userId, m); }
  if (tag && m.tag !== tag) { m.tag = tag; m.dirty = true; }
  return m;
}

export function getXp(userId) {
  return members.get(userId)?.xp || 0;
}

/** Everyone, highest XP first: [{ userId, tag, xp, level }]. */
export function leaderboard(limit = 10) {
  return [...members.entries()]
    .filter(([, m]) => m.xp > 0)
    .sort((a, b) => b[1].xp - a[1].xp)
    .slice(0, limit)
    .map(([userId, m]) => ({ userId, tag: m.tag, xp: m.xp, level: levelFor(m.xp) }));
}

export function rankOf(userId) {
  const xp = getXp(userId);
  if (!xp) return null;
  return [...members.values()].filter((m) => m.xp > xp).length + 1;
}

/* ---------- Giving XP ---------- */

function blocked(member, channelId) {
  if (!cfg?.enabled || !member || member.user?.bot) return true;
  if (channelId && (cfg.no_xp_channel_ids || []).includes(channelId)) return true;
  return (cfg.no_xp_role_ids || []).some((r) => member.roles?.cache?.has(r));
}

/**
 * Adds (or with a negative amount, removes) XP. Announces level-ups and gives reward roles.
 * Returns { xp, before, after } levels.
 */
export async function addXp(member, amount, { announce = true } = {}) {
  const user = member.user || member;
  const m = entry(user.id, user.tag || user.username);
  const before = levelFor(m.xp);
  m.xp = Math.max(0, m.xp + Math.round(amount));
  m.dirty = true;
  const after = levelFor(m.xp);
  if (after > before && member.roles) await giveRewards(member, after);
  if (after > before && announce) await announceLevelUp(member, after).catch((err) => console.warn('[levels] announce failed:', err.message));
  return { xp: m.xp, before, after };
}

/** Gives every reward role at or below this level that the member doesn't have yet. */
async function giveRewards(member, level) {
  const roles = (cfg?.rewards || []).filter((r) => r.level <= level && r.role_id && !member.roles.cache.has(r.role_id)).map((r) => r.role_id);
  if (!roles.length) return [];
  try {
    await member.roles.add(roles, `Reached level ${level}`);
  } catch (err) {
    console.warn('[levels] could not give reward role (is the bot role above it?):', err.message);
    return [];
  }
  return roles;
}

export function levelUpText(member, level) {
  const user = member.user || member;
  const name = member.displayName || user.globalName || user.username || 'someone';
  return String(cfg?.announce_message || '🎉 {mention} just reached **level {level}**!')
    .replace(/\{mention\}/g, `<@${user.id}>`)
    .replace(/\{name\}/g, name)
    .replace(/\{level\}/g, String(level));
}

async function announceLevelUp(member, level) {
  if (!cfg?.announce_channel_id) return;
  const channel = await client.channels.fetch(cfg.announce_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const user = member.user || member;
  const reward = (cfg.rewards || []).filter((r) => r.level === level && r.role_id).map((r) => `<@&${r.role_id}>`);
  const p = progress(getXp(user.id));
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor({ name: '⬆️ Level up!' })
    .setDescription(truncate(`${levelUpText(member, level)}${reward.length ? `\n🏅 New role: ${reward.join(', ')}` : ''}`, 4096))
    .setFooter(footer(`${p.needed - p.into} XP to level ${level + 1}`, client));
  const avatar = user.displayAvatarURL?.({ size: 128 });
  if (avatar) embed.setThumbnail(avatar);
  await channel.send({ content: `<@${user.id}>`, embeds: [embed], allowedMentions: { users: [user.id] } });
}

/** A chat message: message XP (once per cooldown), daily first-message bonus, QOTD bonus. */
export async function handleLevelMessage(message) {
  if (!loaded || !cfg?.enabled || message.author?.bot || !message.member) return;
  if (blocked(message.member, message.channelId)) return;
  const m = entry(message.author.id, message.author.tag || message.author.username);
  const now = message.createdTimestamp || Date.now();
  const text = String(message.content || '').trim();
  let gain = 0;
  const today = todayIn(tz, new Date(now));

  // Daily bonus: first message of the day, any length
  if (cfg.daily_xp > 0 && m.lastDaily !== today) { m.lastDaily = today; gain += cfg.daily_xp; }
  // QOTD bonus: first answer in the QOTD channel each day
  if (cfg.qotd_xp > 0 && cfg.qotd_channel_id && message.channelId === cfg.qotd_channel_id && m.lastQotd !== today && text.length >= 3) {
    m.lastQotd = today; gain += cfg.qotd_xp;
  }
  // Normal message XP: real messages only, once per cooldown, not the same text again
  const real = text.length >= 3 || message.attachments?.size > 0;
  const fresh = now - m.lastMsg >= (cfg.message_cooldown ?? 60) * 1000;
  if (real && fresh && text.toLowerCase() !== m.lastText) {
    m.lastMsg = now;
    m.lastText = text.toLowerCase();
    gain += cfg.message_xp;
  }
  if (gain > 0) await addXp(message.member, gain);
}

/** Boost bonus: called when someone starts boosting. */
export async function handleLevelBoost(oldMember, newMember) {
  if (oldMember.premiumSince || !newMember.premiumSince) return;
  if (!cfg?.enabled || !(cfg.boost_xp > 0) || blocked(newMember)) return;
  await addXp(newMember, cfg.boost_xp);
}

/** Voice XP: every few minutes, everyone in a voice channel with at least one other real person, not deafened. */
export async function voiceTick() {
  if (!loaded || !cfg?.enabled || !(cfg.voice_xp > 0)) return 0;
  const guild = await getGuild().catch(() => null);
  if (!guild) return 0;
  let given = 0;
  for (const channel of guild.channels.cache.values()) {
    if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) continue;
    if (channel.id === guild.afkChannelId || (cfg.no_xp_channel_ids || []).includes(channel.id)) continue;
    const people = [...(channel.members?.values() || [])].filter((mem) => !mem.user?.bot);
    if (people.length < 2) continue;
    for (const mem of people) {
      const vs = mem.voice;
      if (vs?.selfDeaf || vs?.serverDeaf) continue;
      if (blocked(mem, channel.id)) continue;
      await addXp(mem, cfg.voice_xp);
      given++;
    }
  }
  return given;
}

export function startLeveling() {
  const voiceEvery = () => Math.max(1, cfg?.voice_minutes || 3) * 60 * 1000;
  let voiceTimer;
  const scheduleVoice = () => {
    voiceTimer = setTimeout(async () => {
      await voiceTick().catch((e) => console.warn('[levels] voice tick failed:', e.message));
      scheduleVoice();
    }, voiceEvery());
  };
  scheduleVoice();
  const saveTimer = setInterval(() => {
    flushLevels().then((n) => { if (n) console.log(`[levels] saved ${n} member(s)`); }).catch((e) => console.warn('[levels] save failed:', e.message));
  }, SAVE_EVERY_MS);
  return { voiceTimer, saveTimer };
}

export const _levelState = { members };
