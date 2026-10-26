import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';

export const COLORS = {
  brand: 0x3a6be0,
  pending: 0xe0a83a,
  accepted: 0x1f8a55,
  denied: 0xc8413a,
  muted: 0x5c6478,
};

/** Permissions the bot needs. Used for the invite link on the dashboard. */
export const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles;

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

/** True if this guild member can review applications and see staff things. */
export function isStaff(member, settings) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(settings?.staff_role_id && member.roles?.cache?.has(settings.staff_role_id));
}

export const ephemeral = 64; // MessageFlags.Ephemeral
