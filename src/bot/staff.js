import {
  ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  activeStrikes, addStrike, createLoa, decideLoaRow, findOpenLoa, getLoa, getSettings, listLoas, listStrikes,
  revokeStrike, updateLoa,
} from '../db.js';
import { tzParts } from '../schedule.js';
import { client, getGuild } from './client.js';
import { COLORS, ephemeral, isStaff, truncate, unix } from './ui.js';

/* ---------- Who can do what ---------- */

/** Managers issue strikes and approve LOA: Manage Server, or the manager role from Settings. */
export function isManager(member, settings) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(settings?.manager_role_id && member.roles?.cache?.has(settings.manager_role_id));
}

/* ---------- Dates for LOA ---------- */

export function todayIn(tz, now = new Date()) {
  const p = tzParts(now, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY, MM/DD (this year), "today", "tomorrow". Returns YYYY-MM-DD or null. */
export function parseDateInput(value, tz) {
  const v = String(value || '').trim().toLowerCase();
  const today = todayIn(tz);
  if (v === 'today') return today;
  if (v === 'tomorrow') return addDaysStr(today, 1);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  let y; let mo; let d;
  if (m) { [, y, mo, d] = m.map(Number); } else {
    m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(v);
    if (!m) return null;
    mo = Number(m[1]); d = Number(m[2]); y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    if (y < 100) y += 2000;
  }
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

export function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/* ---------- Strikes ---------- */

async function logTo(channelId, payload) {
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send(payload);
  } catch (err) {
    console.warn('[staff] could not post to log channel:', err.message);
  }
}

/** Gives the strike role that matches the number of active strikes and removes the others. */
async function syncStrikeRoles(userId, count, settings) {
  const roles = (settings.strike_role_ids || []).filter(Boolean);
  if (!roles.length) return null;
  const guild = await getGuild();
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return 'They are not in the server, so no strike role was changed.';
  const target = count > 0 ? roles[Math.min(count, roles.length) - 1] : null;
  try {
    const remove = roles.filter((r) => r !== target && member.roles.cache.has(r));
    if (remove.length) await member.roles.remove(remove, 'Strike count changed');
    if (target && !member.roles.cache.has(target)) await member.roles.add(target, `Now at ${count} strike(s)`);
    return null;
  } catch (err) {
    return `Could not update strike roles (${err.message}). The bot's role must be above them.`;
  }
}

/** Returns { ok, error?, strike, count, notes[] }. */
export async function issueStrike({ userId, userTag, reason, issuerId, issuerTag }) {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason for the strike.', notes: [] };
  const settings = await getSettings();
  const strike = await addStrike({ userId, userTag, reason: truncate(reason.trim(), 500), issuedBy: issuerId, issuedByTag: issuerTag });
  const count = (await activeStrikes(userId)).length;
  const notes = [];
  const roleNote = await syncStrikeRoles(userId, count, settings);
  if (roleNote) notes.push(roleNote);

  try {
    const user = await client.users.fetch(userId);
    const guild = await getGuild();
    await user.send({ embeds: [new EmbedBuilder().setColor(COLORS.denied).setTitle(`Staff strike ${count}`)
      .setDescription(`You received a staff strike in **${guild.name}**. You now have **${count}** active strike${count === 1 ? '' : 's'}.`)
      .addFields({ name: 'Reason', value: truncate(reason, 1024) })] });
    notes.push('They were told by DM.');
  } catch { notes.push('Could not DM them.'); }

  const alert = count >= 3 && settings.manager_role_id;
  await logTo(settings.strike_log_channel_id, {
    content: alert ? `<@&${settings.manager_role_id}> <@${userId}> has reached **${count} strikes**.` : undefined,
    allowedMentions: { roles: alert ? [settings.manager_role_id] : [] },
    embeds: [new EmbedBuilder().setColor(COLORS.denied).setTitle(`Strike ${count} · ${userTag}`)
      .addFields(
        { name: 'Member', value: `<@${userId}>`, inline: true },
        { name: 'Issued by', value: issuerId ? `<@${issuerId}>` : issuerTag, inline: true },
        { name: 'Active strikes', value: String(count), inline: true },
        { name: 'Reason', value: truncate(reason, 1024) },
      ).setFooter({ text: `Strike #${strike.id}` })],
  });
  return { ok: true, strike, count, notes };
}

/** Removes one strike (the given one, or their newest). Returns { ok, error?, count, notes[] }. */
export async function removeStrike({ strikeId, userId, byTag }) {
  const settings = await getSettings();
  let target = null;
  if (strikeId) {
    target = await revokeStrike(strikeId, byTag);
  } else {
    const list = await activeStrikes(userId);
    if (list.length) target = await revokeStrike(list.at(-1).id, byTag);
  }
  if (!target) return { ok: false, error: 'No active strike to remove.', notes: [] };
  const count = (await activeStrikes(target.user_id)).length;
  const notes = [];
  const roleNote = await syncStrikeRoles(target.user_id, count, settings);
  if (roleNote) notes.push(roleNote);
  await logTo(settings.strike_log_channel_id, {
    embeds: [new EmbedBuilder().setColor(COLORS.accepted).setTitle(`Strike removed · ${target.user_tag}`)
      .setDescription(`Strike #${target.id} was removed by ${byTag}. <@${target.user_id}> now has **${count}** active strike${count === 1 ? '' : 's'}.`)],
  });
  return { ok: true, count, strike: target, notes };
}

/* ---------- LOA ---------- */

/** Approved LOAs kept in memory so the daily start/end check doesn't wake the database. */
const loaSchedule = new Map(); // id -> { id, user_id, start_date, end_date, role_applied }

function loaCard(loa) {
  const color = { pending: COLORS.pending, approved: COLORS.accepted, denied: COLORS.denied }[loa.status] ?? COLORS.muted;
  const embed = new EmbedBuilder().setColor(color).setTitle(`LOA request · ${loa.user_tag}`)
    .addFields(
      { name: 'Member', value: `<@${loa.user_id}>`, inline: true },
      { name: 'From', value: prettyDate(loa.start_date), inline: true },
      { name: 'Until', value: prettyDate(loa.end_date), inline: true },
      { name: 'Reason', value: truncate(loa.reason || '(none)', 1024) },
    ).setFooter({ text: `LOA #${loa.id}` });
  if (loa.status !== 'pending') {
    embed.addFields({ name: 'Status', value: `${loa.status[0].toUpperCase()}${loa.status.slice(1)}${loa.reviewed_by_tag ? ` by ${loa.reviewed_by_tag}` : ''}` });
  }
  const components = loa.status === 'pending' ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`loa:approve:${loa.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`loa:deny:${loa.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  )] : [];
  return { embeds: [embed], components };
}

async function refreshLoaCard(loa) {
  if (!loa.message_channel_id || !loa.message_id) return;
  try {
    const ch = await client.channels.fetch(loa.message_channel_id);
    const msg = await ch.messages.fetch(loa.message_id);
    await msg.edit(loaCard(loa));
  } catch { /* gone */ }
}

async function setLoaRole(userId, on, settings) {
  if (!settings.loa_role_id) return 'No LOA role is set in Settings, so no role was changed.';
  const guild = await getGuild();
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return 'They are not in the server.';
  try {
    if (on) await member.roles.add(settings.loa_role_id, 'LOA started');
    else await member.roles.remove(settings.loa_role_id, 'LOA ended');
    return null;
  } catch (err) {
    return `Could not change the LOA role (${err.message}). The bot's role must be above it.`;
  }
}

/** Returns { ok, error?, loa }. */
export async function requestLoa({ userId, userTag, start, end, reason }) {
  const settings = await getSettings();
  const tz = settings.timezone;
  const startDate = parseDateInput(start, tz);
  const endDate = parseDateInput(end, tz);
  if (!startDate || !endDate) return { ok: false, error: 'Use dates like 2026-11-03, 11/03, today or tomorrow.' };
  if (endDate < startDate) return { ok: false, error: 'The last day must be on or after the first day.' };
  if (endDate < todayIn(tz)) return { ok: false, error: 'Those dates are already in the past.' };
  const open = await findOpenLoa(userId);
  if (open) return { ok: false, error: `You already have a ${open.status} LOA (${prettyDate(open.start_date)} to ${prettyDate(open.end_date)}).` };

  const loa = await createLoa({ userId, userTag, startDate, endDate, reason: truncate(reason?.trim() || '', 500) });
  if (settings.loa_channel_id) {
    try {
      const ch = await client.channels.fetch(settings.loa_channel_id);
      const msg = await ch.send({
        content: settings.manager_role_id ? `<@&${settings.manager_role_id}> new LOA request` : undefined,
        allowedMentions: { roles: settings.manager_role_id ? [settings.manager_role_id] : [] },
        ...loaCard(loa),
      });
      await updateLoa(loa.id, { message_channel_id: ch.id, message_id: msg.id });
    } catch (err) {
      console.warn('[loa] could not post request:', err.message);
    }
  }
  return { ok: true, loa };
}

/** Approve or deny. Returns { ok, error?, loa, notes[] }. */
export async function decideLoa({ id, approve, byId, byTag }) {
  const settings = await getSettings();
  const loa = await decideLoaRow(id, approve ? 'approved' : 'denied', byId, byTag);
  if (!loa) {
    const existing = await getLoa(id);
    return { ok: false, error: existing ? `Already ${existing.status}.` : 'LOA request not found.', notes: [] };
  }
  const notes = [];
  if (approve) {
    loaSchedule.set(loa.id, { id: loa.id, user_id: loa.user_id, start_date: loa.start_date, end_date: loa.end_date, role_applied: false });
    await runLoaSchedule(settings);
    if (loaSchedule.get(loa.id)?.role_applied) notes.push('LOA role given.');
    else if (loa.start_date > todayIn(settings.timezone)) notes.push(`The LOA role will be added on ${prettyDate(loa.start_date)}.`);
  }
  try {
    const user = await client.users.fetch(loa.user_id);
    await user.send({ embeds: [new EmbedBuilder().setColor(approve ? COLORS.accepted : COLORS.denied)
      .setTitle(approve ? 'LOA approved' : 'LOA denied')
      .setDescription(`Your leave from **${prettyDate(loa.start_date)}** to **${prettyDate(loa.end_date)}** was ${approve ? 'approved' : 'denied'} by ${byTag}.`)] });
    notes.push('They were told by DM.');
  } catch { notes.push('Could not DM them.'); }
  await refreshLoaCard(await getLoa(loa.id));
  return { ok: true, loa, notes };
}

/** Ends an LOA early (or cancels a pending one). */
export async function endLoa({ id, byTag }) {
  const settings = await getSettings();
  const loa = await getLoa(id);
  if (!loa || !['pending', 'approved'].includes(loa.status)) return { ok: false, error: 'That LOA is not active.' };
  const status = loa.status === 'pending' ? 'cancelled' : 'ended';
  if (loa.role_applied || loaSchedule.get(id)?.role_applied) await setLoaRole(loa.user_id, false, settings);
  loaSchedule.delete(id);
  const updated = await updateLoa(id, { status, role_applied: false, reviewed_by_tag: loa.reviewed_by_tag || byTag });
  await refreshLoaCard(updated);
  return { ok: true, loa: updated };
}

/** Adds the LOA role on the first day and removes it after the last day. Runs from memory. */
export async function runLoaSchedule(settingsArg) {
  if (!loaSchedule.size) return;
  const settings = settingsArg || await getSettings();
  const today = todayIn(settings.timezone);
  for (const e of [...loaSchedule.values()]) {
    if (today > e.end_date) {
      if (e.role_applied) await setLoaRole(e.user_id, false, settings);
      await updateLoa(e.id, { status: 'ended', role_applied: false });
      loaSchedule.delete(e.id);
      try { (await client.users.fetch(e.user_id)).send('Welcome back! Your LOA has ended.'); } catch { /* ignore */ }
    } else if (!e.role_applied && today >= e.start_date) {
      const note = await setLoaRole(e.user_id, true, settings);
      if (!note) {
        e.role_applied = true;
        await updateLoa(e.id, { role_applied: true });
      }
    }
  }
}

export async function loadLoaSchedule() {
  for (const l of await listLoas({ status: 'approved' })) {
    loaSchedule.set(l.id, { id: l.id, user_id: l.user_id, start_date: l.start_date, end_date: l.end_date, role_applied: l.role_applied });
  }
  await runLoaSchedule();
  // Check every 15 minutes; only reads memory unless an LOA starts or ends
  return setInterval(() => runLoaSchedule().catch((e) => console.warn('[loa] schedule check failed:', e.message)), 15 * 60 * 1000);
}

export function isOnLoa(userId) {
  const e = [...loaSchedule.values()].find((x) => x.user_id === userId);
  return e ? { onLeaveNow: e.role_applied, ...e } : null;
}

/* ---------- Slash commands ---------- */

export const commandData = [
  {
    name: 'strike',
    description: 'Staff strikes',
    options: [
      { type: ApplicationCommandOptionType.Subcommand, name: 'add', description: 'Give a staff member a strike',
        options: [
          { type: ApplicationCommandOptionType.User, name: 'member', description: 'Who gets the strike', required: true },
          { type: ApplicationCommandOptionType.String, name: 'reason', description: 'Why', required: true, max_length: 500 },
        ] },
      { type: ApplicationCommandOptionType.Subcommand, name: 'remove', description: "Remove a staff member's newest strike",
        options: [{ type: ApplicationCommandOptionType.User, name: 'member', description: 'Whose strike to remove', required: true }] },
      { type: ApplicationCommandOptionType.Subcommand, name: 'list', description: "See a staff member's strikes",
        options: [{ type: ApplicationCommandOptionType.User, name: 'member', description: 'Whose strikes (you, if left empty)', required: false }] },
    ],
  },
  {
    name: 'loa',
    description: 'Leave of absence',
    options: [
      { type: ApplicationCommandOptionType.Subcommand, name: 'request', description: 'Ask for a leave of absence' },
      { type: ApplicationCommandOptionType.Subcommand, name: 'end', description: 'End your leave early, or cancel your request' },
    ],
  },
];

export async function registerCommands(guild) {
  try {
    await guild.commands.set(commandData);
    console.log('[staff] slash commands registered');
  } catch (err) {
    console.warn('[staff] could not register slash commands:', err.message);
  }
}

export async function handleCommand(interaction) {
  const settings = await getSettings();
  const sub = interaction.options.getSubcommand();

  if (interaction.commandName === 'strike') {
    const target = interaction.options.getUser('member');
    if (sub === 'list') {
      const who = target || interaction.user;
      if (who.id !== interaction.user.id && !isManager(interaction.member, settings) && !isStaff(interaction.member, settings)) {
        return interaction.reply({ content: 'Only staff can see other people\'s strikes.', flags: ephemeral });
      }
      const list = await listStrikes({ userId: who.id });
      const active = list.filter((s) => !s.revoked_at);
      const lines = list.slice(0, 15).map((s) => `${s.revoked_at ? '~~' : ''}#${s.id} · <t:${unix(s.created_at)}:d> · ${truncate(s.reason, 120)} (by ${s.issued_by_tag})${s.revoked_at ? '~~ removed' : ''}`);
      return interaction.reply({ content: `**${who.tag}** has **${active.length}** active strike${active.length === 1 ? '' : 's'}.\n${lines.join('\n') || 'No strikes.'}`, flags: ephemeral, allowedMentions: { users: [] } });
    }
    if (!isManager(interaction.member, settings)) return interaction.reply({ content: 'Only managers can give or remove strikes.', flags: ephemeral });
    if (target.bot) return interaction.reply({ content: "Bots can't get strikes.", flags: ephemeral });
    await interaction.deferReply({ flags: ephemeral });
    if (sub === 'add') {
      const r = await issueStrike({ userId: target.id, userTag: target.tag, reason: interaction.options.getString('reason'), issuerId: interaction.user.id, issuerTag: interaction.user.tag });
      return interaction.editReply(r.ok ? `Gave ${target} strike ${r.count}. ${r.notes.join(' ')}` : r.error);
    }
    const r = await removeStrike({ userId: target.id, byTag: interaction.user.tag });
    return interaction.editReply(r.ok ? `Removed a strike. ${target} now has ${r.count}. ${r.notes.join(' ')}` : r.error);
  }

  if (interaction.commandName === 'loa') {
    if (!isStaff(interaction.member, settings) && !isManager(interaction.member, settings)) {
      return interaction.reply({ content: 'LOA requests are for staff.', flags: ephemeral });
    }
    if (sub === 'request') {
      const modal = new ModalBuilder().setCustomId('loa:modal').setTitle('Leave of absence').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start').setLabel('First day away').setPlaceholder('e.g. 2026-11-03, 11/03, today').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('end').setLabel('Last day away').setPlaceholder('e.g. 2026-11-10 or 11/10').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)),
      );
      return interaction.showModal(modal);
    }
    const open = await findOpenLoa(interaction.user.id);
    if (!open) return interaction.reply({ content: "You don't have an LOA to end.", flags: ephemeral });
    await interaction.deferReply({ flags: ephemeral });
    const r = await endLoa({ id: open.id, byTag: interaction.user.tag });
    return interaction.editReply(r.ok ? (r.loa.status === 'cancelled' ? 'Your LOA request was cancelled.' : 'Welcome back! Your LOA has ended.') : r.error);
  }
  return null;
}

export async function handleLoaModal(interaction) {
  await interaction.deferReply({ flags: ephemeral });
  const r = await requestLoa({
    userId: interaction.user.id, userTag: interaction.user.tag,
    start: interaction.fields.getTextInputValue('start'), end: interaction.fields.getTextInputValue('end'),
    reason: interaction.fields.getTextInputValue('reason'),
  });
  return interaction.editReply(r.ok
    ? `Your LOA request (${prettyDate(r.loa.start_date)} to ${prettyDate(r.loa.end_date)}) was sent to managers. I'll DM you when it's reviewed.`
    : r.error);
}

export async function handleLoaButton(interaction) {
  const [, action, id] = interaction.customId.split(':');
  const settings = await getSettings();
  if (!isManager(interaction.member, settings)) return interaction.reply({ content: 'Only managers can review LOA requests.', flags: ephemeral });
  await interaction.deferReply({ flags: ephemeral });
  const r = await decideLoa({ id: Number(id), approve: action === 'approve', byId: interaction.user.id, byTag: interaction.user.tag });
  return interaction.editReply(r.ok ? `${action === 'approve' ? 'Approved' : 'Denied'}. ${r.notes.join(' ')}` : r.error);
}

export const _staffState = { loaSchedule };
