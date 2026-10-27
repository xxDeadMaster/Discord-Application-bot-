// Moderation: /warn /timeout /untimeout /kick /ban /unban /modlogs, with a case history and a mod log channel.
// Every action is saved as a numbered case, the member gets a DM, and the mod log channel gets a card.
import {
  ApplicationCommandOptionType, EmbedBuilder, PermissionFlagsBits,
} from 'discord.js';
import { addModCase, getSettings, listModCases } from '../db.js';
import { client } from './client.js';
import {
  COLORS, ephemeral, footer, notice, truncate, unix,
} from './ui.js';

const T = ApplicationCommandOptionType;
const P = PermissionFlagsBits;
const MAX_TIMEOUT_MIN = 28 * 24 * 60; // Discord's limit

export const ACTIONS = {
  warn: { label: 'Warn', past: 'warned', emoji: '⚠️', color: 0xffc24b, perm: P.ModerateMembers },
  timeout: { label: 'Timeout', past: 'timed out', emoji: '🔇', color: 0xff8a3d, perm: P.ModerateMembers },
  untimeout: { label: 'Timeout removed', past: 'un-timed out', emoji: '🔊', color: COLORS.accepted, perm: P.ModerateMembers },
  kick: { label: 'Kick', past: 'kicked', emoji: '👢', color: 0xe5484d, perm: P.KickMembers },
  ban: { label: 'Ban', past: 'banned', emoji: '🔨', color: 0xb4232a, perm: P.BanMembers },
  unban: { label: 'Unban', past: 'unbanned', emoji: '🕊️', color: COLORS.accepted, perm: P.BanMembers },
};

const memberOpt = { type: T.User, name: 'member', description: 'Who', required: true };
const reasonOpt = (required) => ({ type: T.String, name: 'reason', description: 'Why (they will see this)', required, max_length: 500 });

export const modCommandData = [
  { name: 'warn', description: 'Warn a member', default_member_permissions: String(P.ModerateMembers), options: [memberOpt, reasonOpt(true)] },
  {
    name: 'timeout', description: 'Mute a member for a while', default_member_permissions: String(P.ModerateMembers),
    options: [memberOpt, { type: T.String, name: 'duration', description: 'How long, e.g. 10m, 1h, 1d (max 28d)', required: true, max_length: 20 }, reasonOpt(false)],
  },
  { name: 'untimeout', description: 'Remove a timeout', default_member_permissions: String(P.ModerateMembers), options: [memberOpt, reasonOpt(false)] },
  { name: 'kick', description: 'Kick a member from the server', default_member_permissions: String(P.KickMembers), options: [memberOpt, reasonOpt(false)] },
  {
    name: 'ban', description: 'Ban someone from the server', default_member_permissions: String(P.BanMembers),
    options: [
      { type: T.User, name: 'user', description: 'Who (they don\'t have to be in the server)', required: true },
      reasonOpt(false),
      { type: T.Integer, name: 'delete_messages', description: 'Also delete their recent messages', choices: [
        { name: "Don't delete any", value: 0 }, { name: 'Last hour', value: 3600 }, { name: 'Last 24 hours', value: 86400 }, { name: 'Last 7 days', value: 604800 },
      ] },
    ],
  },
  {
    name: 'unban', description: 'Unban someone', default_member_permissions: String(P.BanMembers),
    options: [{ type: T.String, name: 'user_id', description: 'Their Discord user ID', required: true, max_length: 20 }, reasonOpt(false)],
  },
  {
    name: 'modlogs', description: 'See a member\'s moderation history', default_member_permissions: String(P.ModerateMembers),
    options: [{ type: T.User, name: 'member', description: 'Whose history', required: true }],
  },
];

export const MOD_COMMANDS = modCommandData.map((c) => c.name);

/* ---------- Helpers ---------- */

/** "10m", "2h", "1d 12h", "90" (minutes) -> minutes, or null. */
export function parseMinutes(text) {
  const s = String(text || '').toLowerCase().replace(/,/g, ' ').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const units = { m: 1, h: 60, d: 1440, w: 10080 };
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(/(\d+)\s*(w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?)\b/g)) {
    total += Number(m[1]) * units[m[2][0]];
    matched += m[0];
  }
  return total && matched.replace(/\s/g, '') === s.replace(/\s/g, '') ? total : null;
}

export function prettyMinutes(min) {
  if (!min) return '';
  const d = Math.floor(min / 1440); const h = Math.floor((min % 1440) / 60); const m = min % 60;
  return [d && `${d} day${d === 1 ? '' : 's'}`, h && `${h} hour${h === 1 ? '' : 's'}`, m && `${m} minute${m === 1 ? '' : 's'}`].filter(Boolean).join(' ');
}

function canUse(member, action, settings) {
  if (!member) return false;
  if (member.permissions?.has?.(ACTIONS[action].perm) || member.permissions?.has?.(P.Administrator)) return true;
  return Boolean(settings.manager_role_id && member.roles?.cache?.has(settings.manager_role_id));
}

/** Returns an error message if `mod` may not act on `target`, else null. */
function hierarchyProblem(guild, mod, target) {
  if (!target) return null;
  if (target.id === mod.id) return "You can't do that to yourself.";
  if (target.id === client.user?.id) return "I can't do that to myself.";
  if (target.id === guild.ownerId) return "You can't do that to the server owner.";
  const modTop = mod.roles?.highest?.position ?? 0;
  const targetTop = target.roles?.highest?.position ?? 0;
  if (mod.id !== guild.ownerId && targetTop >= modTop) return 'They have the same or a higher role than you.';
  return null;
}

function caseEmbed(c) {
  const a = ACTIONS[c.action];
  const embed = new EmbedBuilder()
    .setColor(a.color)
    .setAuthor({ name: `${a.emoji} ${a.label} · Case #${c.id}` })
    .addFields(
      { name: 'Member', value: `<@${c.user_id}> (${truncate(c.user_tag, 80)})`, inline: true },
      { name: 'Moderator', value: c.mod_id ? `<@${c.mod_id}>` : c.mod_tag, inline: true },
      ...(c.duration_minutes ? [{ name: 'Length', value: prettyMinutes(c.duration_minutes), inline: true }] : []),
      { name: 'Reason', value: truncate(c.reason || 'No reason given', 1024) },
    )
    .setFooter(footer(`User ID ${c.user_id}`, client))
    .setTimestamp(new Date(c.created_at));
  return embed;
}

async function logCase(c, settings) {
  if (!settings.mod_log_channel_id) return;
  const ch = await client.channels.fetch(settings.mod_log_channel_id).catch(() => null);
  await ch?.send?.({ embeds: [caseEmbed(c)], allowedMentions: { parse: [] } }).catch((err) => console.warn('[mod] could not post to mod log:', err.message));
}

async function dmMember(user, guild, action, reason, minutes) {
  const a = ACTIONS[action];
  const text = action === 'untimeout'
    ? `Your timeout in **${guild.name}** was removed.`
    : `You were **${a.past}** in **${guild.name}**${minutes ? ` for **${prettyMinutes(minutes)}**` : ''}.`;
  try {
    await user.send({ embeds: [new EmbedBuilder().setColor(a.color).setAuthor({ name: `${a.emoji} ${a.label}` })
      .setDescription(`${text}${reason ? `\n\n**Reason:** ${truncate(reason, 1000)}` : ''}`).setFooter(footer('Staff team', client))] });
    return true;
  } catch {
    return false;
  }
}

/* ---------- The actions (used by commands; usable from elsewhere too) ---------- */

/**
 * Runs a moderation action and records it.
 * Returns { ok, error?, case?, dmed? }.
 */
export async function moderate({ guild, action, target, targetUser, mod, reason = '', minutes = null, deleteSeconds = 0 }) {
  const settings = await getSettings();
  const user = target?.user || targetUser;
  let dmed = false;
  try {
    if (action === 'warn') {
      dmed = await dmMember(user, guild, action, reason);
    } else if (action === 'timeout') {
      if (!target?.moderatable) return { ok: false, error: "I can't time out that member. My role needs to be above theirs, with Timeout Members permission." };
      await target.timeout(minutes * 60 * 1000, truncate(`${mod.user?.tag || mod.id}: ${reason}`, 500));
      dmed = await dmMember(user, guild, action, reason, minutes);
    } else if (action === 'untimeout') {
      if (!target?.isCommunicationDisabled?.()) return { ok: false, error: "They aren't timed out." };
      await target.timeout(null, truncate(`${mod.user?.tag || mod.id}: ${reason}`, 500));
      dmed = await dmMember(user, guild, action, reason);
    } else if (action === 'kick') {
      if (!target?.kickable) return { ok: false, error: "I can't kick that member. My role needs to be above theirs, with Kick Members permission." };
      dmed = await dmMember(user, guild, action, reason); // DM first: after a kick we can't reach them
      await target.kick(truncate(`${mod.user?.tag || mod.id}: ${reason}`, 500));
    } else if (action === 'ban') {
      if (target && !target.bannable) return { ok: false, error: "I can't ban that member. My role needs to be above theirs, with Ban Members permission." };
      if (target) dmed = await dmMember(user, guild, action, reason);
      await guild.members.ban(user.id, { reason: truncate(`${mod.user?.tag || mod.id}: ${reason}`, 500), deleteMessageSeconds: deleteSeconds || 0 });
    } else if (action === 'unban') {
      await guild.members.unban(user.id, truncate(`${mod.user?.tag || mod.id}: ${reason}`, 500));
    }
  } catch (err) {
    return { ok: false, error: `Discord said no: ${err.message}` };
  }
  const c = await addModCase({
    userId: user.id, userTag: user.tag || user.username || user.id, modId: mod.id, modTag: mod.user?.tag || mod.user?.username || mod.id,
    action, reason, durationMinutes: action === 'timeout' ? minutes : null,
  });
  await logCase(c, settings);
  return { ok: true, case: c, dmed };
}

/* ---------- Slash command handler ---------- */

const say = (interaction, text, kind) => (interaction.deferred
  ? interaction.editReply({ embeds: [notice(text, kind)] })
  : interaction.reply({ embeds: [notice(text, kind)], flags: ephemeral }));

export async function handleModCommand(interaction) {
  const settings = await getSettings();
  const name = interaction.commandName;
  const action = name === 'modlogs' ? 'warn' : name;
  if (!canUse(interaction.member, action, settings)) return say(interaction, "You don't have permission to do that.", 'blocked');
  const guild = interaction.guild;
  const mod = interaction.member;

  if (name === 'modlogs') {
    const user = interaction.options.getUser('member');
    const cases = await listModCases({ userId: user.id, limit: 15 });
    const lines = cases.map((c) => `${ACTIONS[c.action]?.emoji || '•'} **#${c.id} ${ACTIONS[c.action]?.label || c.action}**${c.duration_minutes ? ` (${prettyMinutes(c.duration_minutes)})` : ''} · <t:${unix(c.created_at)}:d> · by ${truncate(c.mod_tag, 40)}\n> ${truncate(c.reason || 'No reason', 150)}`);
    const embed = new EmbedBuilder().setColor(COLORS.brand).setAuthor({ name: '📋 Moderation history' }).setTitle(truncate(user.tag || user.username, 256))
      .setDescription(truncate(lines.join('\n\n') || 'No cases. 🎉', 4096)).setFooter(footer(`${cases.length} case${cases.length === 1 ? '' : 's'} shown`, client));
    return interaction.reply({ embeds: [embed], flags: ephemeral, allowedMentions: { parse: [] } });
  }

  const reason = interaction.options.getString('reason')?.trim() || '';
  let target = null;
  let targetUser = null;
  let minutes = null;
  if (name === 'unban') {
    const id = interaction.options.getString('user_id').replace(/\D/g, '');
    if (!/^\d{17,20}$/.test(id)) return say(interaction, "That doesn't look like a Discord user ID.", 'error');
    targetUser = await client.users.fetch(id).catch(() => null);
    if (!targetUser) return say(interaction, "I couldn't find that user.", 'error');
  } else {
    targetUser = interaction.options.getUser(name === 'ban' ? 'user' : 'member');
    target = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!target && name !== 'ban') return say(interaction, "They aren't in the server.", 'error');
    if (targetUser.bot && name === 'warn') return say(interaction, "Bots can't be warned.", 'error');
    const problem = hierarchyProblem(guild, mod, target || (targetUser.id === mod.id ? { id: mod.id } : null));
    if (problem) return say(interaction, problem, 'blocked');
  }
  if (name === 'timeout') {
    minutes = parseMinutes(interaction.options.getString('duration'));
    if (!minutes || minutes < 1) return say(interaction, 'Use a length like `10m`, `1h` or `1d`.', 'error');
    if (minutes > MAX_TIMEOUT_MIN) return say(interaction, 'Timeouts can be 28 days at most.', 'error');
  }
  await interaction.deferReply({ flags: ephemeral });
  const r = await moderate({
    guild, action: name, target, targetUser, mod, reason, minutes,
    deleteSeconds: name === 'ban' ? (interaction.options.getInteger('delete_messages') || 0) : 0,
  });
  if (!r.ok) return say(interaction, r.error, 'error');
  const a = ACTIONS[name];
  return say(interaction, `${a.emoji} <@${targetUser.id}> was ${a.past}${minutes ? ` for **${prettyMinutes(minutes)}**` : ''}. Case **#${r.case.id}**.${['warn', 'timeout', 'kick', 'ban'].includes(name) && !r.dmed ? " (I couldn't DM them.)" : ''}${settings.mod_log_channel_id ? '' : ' Tip: pick a mod log channel on the Moderation page.'}`, 'success');
}
