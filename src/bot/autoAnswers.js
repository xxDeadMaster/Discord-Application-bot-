// Auto-answers: when a member asks a common question ("how do I apply"), Orbit replies with the answer.
// Only in the channels picked on the dashboard, never to staff, and with cooldowns so it never spams.
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { getSettings, query } from '../db.js';
import { client } from './client.js';
import { COLORS, footer, isStaff, truncate } from './ui.js';

const CHANNEL_COOLDOWN = 10 * 60_000; // same answer, same channel
const USER_COOLDOWN = 30 * 60_000; // same answer, same person
export const MAX_ANSWERS = 50;

let answers = []; // [{ id, phrases: [], answer, enabled }]
let channelIds = new Set();
let settingsCache = null;
const lastInChannel = new Map(); // `${answerId}:${channelId}` -> ms
const lastForUser = new Map(); // `${answerId}:${userId}` -> ms

/** Lowercase, no punctuation, single spaces: "How do I APPLY??" -> "how do i apply". */
export function normalize(text) {
  return ` ${String(text || '').toLowerCase().replace(/<[@#&!:a-z0-9_]+>/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()} `;
}

export const parsePhrases = (text) => String(text || '').split(/\r?\n|,/).map((p) => p.trim()).filter(Boolean).slice(0, 20);

export async function listAutoAnswers() {
  const { rows } = await query('SELECT * FROM auto_answers WHERE guild_id = $1 ORDER BY position, id', [config.guildId]);
  return rows;
}

export async function loadAutoAnswers() {
  const [rows, s] = await Promise.all([listAutoAnswers(), getSettings()]);
  settingsCache = s;
  channelIds = new Set(s.auto_answer_channel_ids || []);
  answers = rows.map((r) => ({ id: r.id, enabled: r.enabled, answer: r.answer, phrases: parsePhrases(r.triggers).map(normalize).filter((p) => p.trim().length >= 3) }));
}

export async function saveAutoAnswer({ id = null, triggers, answer, enabled = true }) {
  if (id) {
    const { rows } = await query('UPDATE auto_answers SET triggers = $3, answer = $4, enabled = $5 WHERE guild_id = $1 AND id = $2 RETURNING *', [config.guildId, id, triggers, answer, enabled]);
    return rows[0] || null;
  }
  const { rows } = await query(
    `INSERT INTO auto_answers (guild_id, triggers, answer, enabled, position)
     VALUES ($1, $2, $3, $4, (SELECT coalesce(max(position), 0) + 1 FROM auto_answers WHERE guild_id = $1)) RETURNING *`,
    [config.guildId, triggers, answer, enabled],
  );
  return rows[0];
}

export async function deleteAutoAnswer(id) {
  await query('DELETE FROM auto_answers WHERE guild_id = $1 AND id = $2', [config.guildId, id]);
}

/** The first enabled answer whose phrase appears in the text, or null. */
export function matchAnswer(text) {
  const t = normalize(text);
  if (t.trim().length < 6) return null;
  return answers.find((a) => a.enabled && a.phrases.some((p) => t.includes(p))) || null;
}

export function answerEmbed(answer) {
  return new EmbedBuilder().setColor(COLORS.sky).setDescription(truncate(answer, 4000)).setFooter(footer('Auto-answer · ask staff if this didn\'t help', client));
}

/** Message handler. Returns true when Orbit answered. */
export async function handleAutoAnswer(message, now = Date.now()) {
  if (!answers.length || message.author?.bot || !channelIds.has(message.channelId)) return false;
  if (isStaff(message.member, settingsCache) || (settingsCache?.manager_role_id && message.member?.roles?.cache?.has(settingsCache.manager_role_id))) return false;
  const hit = matchAnswer(message.content);
  if (!hit) return false;
  const ck = `${hit.id}:${message.channelId}`;
  const uk = `${hit.id}:${message.author.id}`;
  if (now - (lastInChannel.get(ck) || 0) < CHANNEL_COOLDOWN || now - (lastForUser.get(uk) || 0) < USER_COOLDOWN) return false;
  lastInChannel.set(ck, now);
  lastForUser.set(uk, now);
  await message.reply({ embeds: [answerEmbed(hit.answer)], allowedMentions: { repliedUser: false, parse: [] } });
  query('UPDATE auto_answers SET uses = uses + 1 WHERE id = $1', [hit.id]).catch(() => {});
  return true;
}

export const _autoState = { lastInChannel, lastForUser, get answers() { return answers; } };
