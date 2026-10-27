// Server stat counters: keeps channel names like "all-members-170" up to date (replaces the ServerStats bot).
// Light on purpose: counts come from the member list the bot already keeps, the counter list is kept in memory,
// and a channel is only renamed when its number changed (Discord allows 2 renames per channel every 10 minutes).
import { ChannelType } from 'discord.js';
import { getSettings, listCounters, saveSnapshot } from '../db.js';
import { tzParts } from '../schedule.js';
import { getGuild } from './client.js';

export const COUNTER_KINDS = {
  members: { label: 'All members', template: 'all-members-{count}' },
  humans: { label: 'Members (no bots)', template: 'members-{count}' },
  bots: { label: 'Bots', template: 'bots-{count}' },
  channels: { label: 'Channels', template: 'channels-{count}' },
  boosts: { label: 'Boosts', template: 'boosts-{count}' },
  staff: { label: 'Staff (staff role)', template: 'staff-{count}' },
};

const RENAME_GAP_MS = 10 * 60 * 1000;
let counters = null; // cached list from the database
let staffRoleId = null;
const lastRename = new Map(); // channelId -> ms

export async function loadCounters() {
  counters = await listCounters();
  staffRoleId = (await getSettings()).staff_role_id || null;
  return counters;
}

/** Called after the dashboard saves counters (or Settings). */
export function setCounters(list, staffRole) {
  counters = list;
  if (staffRole !== undefined) staffRoleId = staffRole;
}

/** The current number for a kind. */
export function countFor(kind, guild) {
  const members = guild.members?.cache;
  switch (kind) {
    case 'members': return guild.memberCount ?? members?.size ?? 0;
    case 'humans': return members ? members.filter((m) => !m.user?.bot).size : 0;
    case 'bots': return members ? members.filter((m) => m.user?.bot).size : 0;
    case 'channels': return guild.channels.cache.filter((c) => !c.isThread?.() && c.type !== ChannelType.GuildCategory).size; // like ServerStats: no categories or threads
    case 'boosts': return guild.premiumSubscriptionCount ?? 0;
    case 'staff': return staffRoleId ? (guild.roles.cache.get(staffRoleId)?.members?.size ?? 0) : 0;
    default: return 0;
  }
}

/** How Discord will show a name: text channels are lowercase with dashes instead of spaces. */
export function normalizeName(name, channelType) {
  const n = String(name).trim().slice(0, 100);
  if (channelType === ChannelType.GuildText || channelType === ChannelType.GuildAnnouncement) {
    return n.toLowerCase().replace(/\s+/g, '-');
  }
  return n;
}

export function counterName(counter, guild) {
  const n = countFor(counter.kind, guild).toLocaleString('en-US');
  return String(counter.template || COUNTER_KINDS[counter.kind]?.template || '{count}').replace(/\{count\}/g, n);
}

/** One pass: rename any counter channel whose number changed. Returns how many were renamed. */
export async function updateCounters({ now = Date.now(), force = false } = {}) {
  if (!counters) await loadCounters();
  if (!counters.length) return 0;
  const guild = await getGuild().catch(() => null);
  if (!guild) return 0;
  let renamed = 0;
  for (const c of counters) {
    const channel = guild.channels.cache.get(c.channel_id);
    if (!channel) continue;
    const want = normalizeName(counterName(c, guild), channel.type);
    if (channel.name === want) continue;
    if (!force && now - (lastRename.get(channel.id) || 0) < RENAME_GAP_MS) continue;
    try {
      await channel.setName(want, 'Server stats update');
      lastRename.set(channel.id, now);
      renamed++;
    } catch (err) {
      console.warn(`[counters] could not rename #${channel.name}:`, err.message);
    }
  }
  return renamed;
}

export function startCounters() {
  updateCounters().catch((e) => console.warn('[counters] update failed:', e.message));
  return setInterval(() => updateCounters().catch((e) => console.warn('[counters] update failed:', e.message)), RENAME_GAP_MS);
}

/** Guesses counters from channel names like "all-members-170", "bots-16" (to take over from ServerStats). */
export function detectCounters(guild) {
  const patterns = [
    ['members', /^all-?members/i], ['humans', /^members/i], ['bots', /^bots/i], ['channels', /^channels/i], ['boosts', /^boosts/i],
  ];
  const out = [];
  for (const ch of guild.channels.cache.values()) {
    if (ch.isThread?.() || ch.type === ChannelType.GuildCategory) continue;
    const name = ch.name.replace(/[\d,.]+\s*$/, '').replace(/[-:\s]+$/, '');
    if (!/\d/.test(ch.name)) continue;
    const hit = patterns.find(([, re]) => re.test(name));
    if (hit && !out.some((o) => o.kind === hit[0])) {
      const template = ch.name.replace(/[\d,.]+(?=\s*$)/, '{count}');
      out.push({ channelId: ch.id, kind: hit[0], template });
    }
  }
  const order = ['members', 'humans', 'bots', 'channels', 'boosts'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/* ---------- Daily snapshot for the dashboard chart (one row per day) ---------- */

let lastSnapshotDay = null;
// Joins and leaves are counted in memory and only written with the daily snapshot (no extra database wake-ups)
const tally = { day: null, joins: 0, leaves: 0 };
let snapshotTz = 'America/New_York';

function dayIn(tz, now = new Date()) {
  const p = tzParts(now, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Called from the member join/leave events. */
export function countMemberChange(kind, now = new Date()) {
  const day = dayIn(snapshotTz, now);
  if (tally.day !== day) { tally.day = day; tally.joins = 0; tally.leaves = 0; }
  tally[kind === 'join' ? 'joins' : 'leaves'] += 1;
}

/** Today's joins/leaves not saved yet (the dashboard adds these to today's row). */
export const unsavedTally = () => ({ ...tally });
export const snapshotTimezone = () => snapshotTz;

/** The numbers shown in the dashboard's Server Overview. */
export function serverNumbers(guild) {
  return {
    members: countFor('members', guild),
    humans: countFor('humans', guild),
    bots: countFor('bots', guild),
    channels: countFor('channels', guild),
    roles: Math.max(0, (guild.roles?.cache?.size || 1) - 1),
    boosts: countFor('boosts', guild),
  };
}

/** Writes the counted joins/leaves (and current totals) for the tally's day, then resets the tally. */
async function saveTally(guild, day) {
  const { joins, leaves } = tally.day === day ? tally : { joins: 0, leaves: 0 };
  tally.joins = 0; tally.leaves = 0;
  try {
    await saveSnapshot(day, { ...serverNumbers(guild), joins, leaves });
  } catch (err) {
    if (tally.day === day) { tally.joins += joins; tally.leaves += leaves; } // keep them for next time
    throw err;
  }
}

/**
 * Checked hourly. Writes at most once a day: when the day changes it saves the day that just ended
 * (with its joins/leaves) and starts today's row.
 */
export async function snapshotTick(now = new Date()) {
  const guild = await getGuild().catch(() => null);
  if (!guild) return false;
  snapshotTz = (await getSettings()).timezone || snapshotTz;
  const day = dayIn(snapshotTz, now);
  if (day === lastSnapshotDay) return false;
  if (tally.day && tally.day !== day && (tally.joins || tally.leaves)) await saveTally(guild, tally.day);
  if (tally.day !== day) { tally.day = day; tally.joins = 0; tally.leaves = 0; }
  await saveTally(guild, day);
  lastSnapshotDay = day;
  return true;
}

/** On shutdown/deploy: save today's joins/leaves so they aren't lost. */
export async function flushSnapshot() {
  if (!tally.day || (!tally.joins && !tally.leaves)) return false;
  const guild = await getGuild().catch(() => null);
  if (!guild) return false;
  await saveTally(guild, tally.day);
  return true;
}

export function startSnapshots() {
  snapshotTick().catch((e) => console.warn('[snapshot] failed:', e.message));
  return setInterval(() => snapshotTick().catch((e) => console.warn('[snapshot] failed:', e.message)), 60 * 60 * 1000);
}
