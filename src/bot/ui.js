import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';

/** Orbit theme: BloxVerse black, blue and white. Status colors only for status. */
export const COLORS = {
  brand: 0x1f6feb, // BloxVerse blue: panels, main messages
  sky: 0x58a6ff, // lighter blue: DMs, info, tickets
  white: 0xf2f5fa, // neutral notices
  pending: 0xffc24b,
  accepted: 0x2fb27a,
  denied: 0xe5484d,
  muted: 0x2c3547,
};

/** Text name used in footers and banners. */
export const BRAND = 'BloxVerse Community';

/** Footer with the bot's avatar: "BloxVerse Community · Application #12". */
export function footer(text, client) {
  const icon = client?.user?.displayAvatarURL?.({ size: 64 });
  const t = text ? `${BRAND} · ${text}` : BRAND;
  return icon ? { text: truncate(t, 2048), iconURL: icon } : { text: truncate(t, 2048) };
}

/** "▰▰▰▱▱▱ 50%" style progress bar. */
export function progressBar(done, total, width = 20) {
  const ratio = total ? Math.min(Math.max(done / total, 0), 1) : 0;
  const filled = Math.round(ratio * width);
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)} ${Math.round(ratio * 100)}%`;
}

/** Status line used on cards, e.g. "⏳ **PENDING**". */
export const STATUS_LABEL = {
  pending: '⏳ **PENDING**',
  accepted: '✅ **ACCEPTED**',
  denied: '❌ **DENIED**',
  open: '🟢 **OPEN**',
  closed: '🔒 **CLOSED**',
};

/** How old a Discord account is, from its snowflake ID ("2 years", "3 months", "5 days"). */
export function accountAge(userId) {
  try {
    const created = Number((BigInt(userId) >> 22n) + 1420070400000n);
    const days = Math.floor((Date.now() - created) / 86400000);
    if (days >= 365) { const y = Math.floor(days / 365); return `${y} year${y === 1 ? '' : 's'}`; }
    if (days >= 30) { const m = Math.floor(days / 30); return `${m} month${m === 1 ? '' : 's'}`; }
    return `${days} day${days === 1 ? '' : 's'}`;
  } catch {
    return 'unknown';
  }
}

/** A single emoji from user input, or null. Accepts unicode emoji or <:name:id> custom emoji. */
export function cleanEmoji(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^<a?:\w{2,32}:\d{17,20}>$/.test(v)) return v;
  const m = v.match(/^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/u);
  return m ? m[0] : null;
}

/** Emoji for select menu options ({ name } or { id, name, animated }). */
export function optionEmoji(emoji) {
  if (!emoji) return undefined;
  const custom = /^<(a?):(\w+):(\d+)>$/.exec(emoji);
  return custom ? { id: custom[3], name: custom[2], animated: custom[1] === 'a' } : { name: emoji };
}

/** "🛡️ Admin" when an emoji is set, otherwise just "Admin". */
export const withEmoji = (emoji, text) => (emoji ? `${emoji} ${text}` : text);

/** Permissions the bot needs. Used for the invite link on the dashboard. */
export const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.MentionEveryone;

export function inviteUrl() {
  return `https://discord.com/oauth2/authorize?client_id=${config.clientId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS.toString()}&guild_id=${config.guildId}`;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function unix(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

export function dashboardLink(path) {
  return `${config.publicUrl}${path}`;
}

/**
 * Turns [{q, a}] into embed fields while staying under Discord's limits
 * (25 fields, 1024 chars per value, 6000 chars per message).
 */
export const MAX_QUESTIONS = 20;

export function answerFields(answers, { budget = 4800 } = {}) {
  const list = answers.slice(0, MAX_QUESTIONS);
  const per = Math.floor(budget / Math.max(list.length, 1));
  const nameMax = Math.min(256, Math.max(40, Math.floor(per * 0.4)));
  let cut = false;
  const fields = list.map((item, i) => {
    const name = truncate(`${i + 1}. ${item.q}`, nameMax);
    const valueMax = Math.min(1024, Math.max(60, per - name.length));
    const answer = item.a || '(no answer)';
    if (answer.length > valueMax || name.length < `${i + 1}. ${item.q}`.length) cut = true;
    return { name, value: truncate(answer, valueMax) };
  });
  return { fields, cut: cut || answers.length > list.length };
}

/**
 * The owner's staff access list for a bot ('orbit' or 'sentinel'). When the list is empty there is no
 * restriction. When it has people, only the server owner and those people pass, even admins.
 */
export const accessList = (settings, bot = 'orbit') => settings?.[bot === 'sentinel' ? 'sentinel_access_ids' : 'orbit_access_ids'] || [];
export function onAccessList(member, settings, bot = 'orbit') {
  if (!member) return false;
  const list = accessList(settings, bot);
  if (!list.length) return true;
  const id = member.id || member.user?.id;
  return (Boolean(member.guild?.ownerId) && id === member.guild.ownerId) || list.includes(id);
}

/**
 * When the Orbit access list is on: the picked people who are still staff (staff role, one of `roleIds`,
 * or Manage Server), for giving them a private channel one by one. null when the list is off.
 */
export function pickedStaff(guild, settings, roleIds = []) {
  const list = accessList(settings, 'orbit');
  if (!list.length) return null;
  return list.filter((id) => {
    const m = guild.members.cache.get(id);
    return m && !m.user?.bot && (isStaff(m, settings) || roleIds.some((r) => m.roles?.cache?.has(r)));
  });
}

/** True if this guild member can review applications and see staff things. */
export function isStaff(member, settings) {
  if (!member) return false;
  if (!onAccessList(member, settings)) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(settings?.staff_role_id && member.roles?.cache?.has(settings.staff_role_id));
}

// Staff commands are hidden in Discord's command list for members without Manage Messages (staff have it).
// Orbit still checks the staff role and the access list itself.
export const STAFF_ONLY = String(PermissionFlagsBits.ManageMessages);

export const ephemeral = 64; // MessageFlags.Ephemeral

/** Small one-line message embed: notice('Check your DMs!', 'success'). */
const NOTICE = {
  info: { color: COLORS.sky, emoji: '💬' },
  success: { color: COLORS.accepted, emoji: '✅' },
  warn: { color: COLORS.pending, emoji: '⏳' },
  error: { color: COLORS.denied, emoji: '⛔' },
  blocked: { color: COLORS.denied, emoji: '🚫' },
};
export function notice(text, kind = 'info') {
  const k = NOTICE[kind] || NOTICE.info;
  return { color: k.color, description: truncate(`${k.emoji} ${text}`, 4096) };
}
