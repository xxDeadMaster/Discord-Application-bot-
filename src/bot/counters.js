// Server stat counters: keeps channel names like "all-members-170" up to date (replaces the ServerStats bot).
// Light on purpose: counts come from the member list the bot already keeps, the counter list is kept in memory,
// and a channel is only renamed when its number changed (Discord allows 2 renames per channel every 10 minutes).
import { ChannelType } from 'discord.js';
import { getSettings, listCounters } from '../db.js';
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
