// Spam trap: a channel nobody should post in. Spam bots post in every channel they can see,
// so anyone (who isn't staff) posting here is removed and their last hour of messages deleted.
// Costs nothing extra: it checks the channel ID of messages Orbit already receives.
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { BOT } from '../config.js';
import { getSettings, updateSettings } from '../db.js';
import { client } from './client.js';
import { recordAutoCase } from './moderation.js';
import { COLORS, footer } from './ui.js';

// Kept in memory so normal messages never touch the database.
let trap = { channelId: null, messageId: null, caught: 0, staffRoleId: null, managerRoleId: null, active: BOT === 'orbit', renameOn: false, renameTime: '04:00', renameLast: null, names: [], tz: 'America/New_York' };
const recent = new Set(); // users being handled right now (spam bots send many messages at once)

export async function loadTrap() {
  const s = await getSettings();
  trap = {
    channelId: s.trap_channel_id, messageId: s.trap_message_id, caught: s.trap_caught || 0, staffRoleId: s.staff_role_id, managerRoleId: s.manager_role_id,
    active: (s.protection_bot || 'orbit') === BOT,
    renameOn: Boolean(s.trap_rename_enabled), renameTime: s.trap_rename_time || '04:00', renameLast: s.trap_rename_last || null,
    names: s.trap_rename_names || [], tz: s.timezone || 'America/New_York',
  };
  return trap;
}

export const trapState = () => ({ ...trap });

export function trapMessage(caught = trap.caught) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.denied ?? 0xe5484d)
      .setTitle('🚫 Do not send messages in this channel')
      .setDescription([
        'This channel is a **trap for spam bots**. It is not used for anything else.',
        '',
        'Anyone who posts here is **removed from the server automatically** and their recent messages are deleted.',
        'If you are reading this, you are fine: just don\'t send anything.',
      ].join('\n'))
      .addFields({ name: 'Caught so far', value: `🪤 **${caught}**`, inline: true })
      .setFooter(footer('Spam protection', client))],
    allowedMentions: { parse: [] },
  };
}

/** Posts the warning message in the trap channel (or edits the one already there). */
export async function publishTrap() {
  await loadTrap();
  if (!trap.channelId) throw new Error('Pick a trap channel first.');
  const channel = await client.channels.fetch(trap.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('The bot cannot find that channel.');
  if (trap.messageId) {
    const existing = await channel.messages.fetch(trap.messageId).catch(() => null);
    if (existing && existing.author?.id === client.user?.id) { await existing.edit(trapMessage()); return { updated: true }; }
    if (existing) await existing.delete().catch(() => {}); // posted by the other bot (Orbit/Sentinel hand-off): replace it
  }
  const msg = await channel.send(trapMessage());
  await updateSettings({ trap_message_id: msg.id });
  trap.messageId = msg.id;
  return { updated: false };
}

function isExempt(member) {
  if (!member) return false;
  const p = member.permissions;
  if (p?.has?.(PermissionFlagsBits.Administrator) || p?.has?.(PermissionFlagsBits.ManageMessages) || p?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  return [trap.staffRoleId, trap.managerRoleId].some((r) => r && member.roles?.cache?.has(r));
}

/** Returns truthy if the message was in the trap channel (so other handlers can skip it): 'caught' when someone was removed. */
export async function handleTrapMessage(message) {
  // Only one bot runs the trap (Settings: protection_bot). The other one ignores it.
  if (!trap.active || !trap.channelId || message.channelId !== trap.channelId) return false;
  if (message.author?.bot || message.webhookId || message.system) return true;
  if (message.id === trap.messageId) return true;
  if (isExempt(message.member)) return true; // staff testing: leave it alone
  const user = message.author;
  if (recent.has(user.id)) { message.delete().catch(() => {}); return true; }
  recent.add(user.id);
  setTimeout(() => recent.delete(user.id), 60 * 1000);
  const guild = message.guild;
  const reason = 'Spam trap: posted in the spam trap channel';
  let action = 'kick';
  try {
    // "Soft ban": ban (which deletes their last hour of messages everywhere), then unban right away
    await guild.members.ban(user.id, { reason, deleteMessageSeconds: 3600 });
    await guild.members.unban(user.id, 'Spam trap: soft ban finished').catch(() => {});
  } catch {
    // No Ban Members permission: kick instead and just delete this message
    await message.delete().catch(() => {});
    try { await message.member?.kick(reason); } catch (err) {
      console.warn('[trap] could not remove', user.tag, err.message);
      return true;
    }
    action = 'kick';
  }
  trap.caught += 1;
  console.log(`[trap] removed ${user.tag || user.id} (${trap.caught} caught)`);
  await updateSettings({ trap_caught: trap.caught }).catch(() => {});
  await recordAutoCase({ user, action, reason: `${reason} (recent messages deleted)` }).catch((err) => console.warn('[trap] could not record case:', err.message));
  if (trap.messageId) {
    message.channel.messages.fetch(trap.messageId).then((m) => m.edit(trapMessage())).catch(() => {});
  }
  return 'caught'; // truthy like the other cases; Sentinel uses it to count catches
}

/* ---------- Daily rename ----------
   Spam bots learn trap channel names and skip them. Renaming the trap every day to a normal-looking,
   read-only-sounding name keeps it working. Names that invite chatting ("general") would catch real members. */

export const DEFAULT_TRAP_NAMES = [
  'summary', 'recap', 'highlights', 'daily-digest', 'info-board', 'server-notes', 'archive', 'bulletin',
  'weekly-recap', 'spotlight', 'notices', 'status-board', 'news-feed', 'server-log', 'reference', 'overview',
];

/** Turns typed names into valid Discord text-channel names (lowercase, dashes, no spaces). */
export function cleanTrapNames(text) {
  return [...new Set(String(text || '').split(/\r?\n|,/)
    .map((n) => n.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\uFE0F\u200D│|_-]/gu, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 90))
    .filter(Boolean))].slice(0, 50);
}

const plainName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A different name from the list (never the current one). */
export function pickTrapName(current, pool, rand = Math.random) {
  const list = (pool && pool.length ? pool : DEFAULT_TRAP_NAMES).filter((n) => plainName(n) !== plainName(current));
  const from = list.length ? list : DEFAULT_TRAP_NAMES;
  return from[Math.floor(rand() * from.length) % from.length];
}

/** Date and HH:MM in the server's timezone. */
export function localNow(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

/** Renames the trap channel now. Returns { from, name }. */
export async function renameTrap(reason = 'Daily spam-trap rename', now = new Date()) {
  if (!trap.channelId) throw new Error('Pick a trap channel first.');
  const channel = await client.channels.fetch(trap.channelId).catch(() => null);
  if (!channel?.setName) throw new Error('The bot cannot find the trap channel.');
  const from = channel.name;
  const name = pickTrapName(from, trap.names);
  await channel.setName(name, reason);
  const { date } = localNow(trap.tz, now);
  trap.renameLast = date;
  await updateSettings({ trap_rename_last: date }).catch(() => {});
  console.log(`[trap] renamed #${from} -> #${name}`);
  return { from, name };
}

/** Called every minute: renames once a day at (or after, if the bot was offline) the chosen time. Uses memory only. */
export async function trapRenameTick(now = new Date()) {
  if (!trap.active || !trap.channelId || !trap.renameOn) return null;
  const { date, hm } = localNow(trap.tz, now);
  if (hm < trap.renameTime || trap.renameLast === date) return null;
  trap.renameLast = date; // set first so a slow rename can't run twice
  return renameTrap('Daily spam-trap rename', now);
}

let renameTimer = null;
export function startTrapRenamer() {
  if (renameTimer) return;
  renameTimer = setInterval(() => trapRenameTick().catch((err) => console.warn('[trap] daily rename failed:', err.message)), 60_000);
  renameTimer.unref?.();
}
