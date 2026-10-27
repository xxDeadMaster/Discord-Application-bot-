import {
  ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  activeStrikes, addStrike, createLoa, decideLoaRow, findOpenLoa, getLoa, getSettings, listLoas, listStrikes,
  revokeStrike, updateLoa,
} from '../db.js';
import { tzParts } from '../schedule.js';
import { communityCommandData, levelCommandData } from './communityCommands.js';
import { client, getGuild } from './client.js';
import {
  COLORS, ephemeral, footer, isStaff, notice, truncate, unix,
} from './ui.js';

/** 🟥🟥⬛ style meter: filled for active strikes, at least 3 slots. */
const strikeMeter = (n) => `${'🟥'.repeat(n)}${'⬛'.repeat(Math.max(3 - n, 0))}`;
/** Puts a plain-text reply into a notice embed so every bot reply looks the same. */
const say = (text, kind = 'info') => ({ content: '', embeds: [notice(text, kind)] });

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
    await user.send({ embeds: [new EmbedBuilder().setColor(COLORS.denied).setAuthor({ name: '⚠️ Staff strike' }).setTitle(`Strike ${count}`)
      .setDescription(`You received a staff strike in **${guild.name}**.\n${strikeMeter(count)} **${count}** active strike${count === 1 ? '' : 's'}`)
      .addFields({ name: 'Reason', value: truncate(reason, 1024) })
      .setFooter(footer('Staff team', client))] });
    notes.push('They were told by DM.');
  } catch { notes.push('Could not DM them.'); }

  const alert = count >= 3 && settings.manager_role_id;
  await logTo(settings.strike_log_channel_id, {
    content: alert ? `<@&${settings.manager_role_id}> <@${userId}> has reached **${count} strikes**.` : undefined,
    allowedMentions: { roles: alert ? [settings.manager_role_id] : [] },
    embeds: [new EmbedBuilder().setColor(COLORS.denied).setAuthor({ name: '⚠️ Strike given' }).setTitle(`Strike ${count} · ${userTag}`)
      .addFields(
        { name: 'Member', value: `<@${userId}>`, inline: true },
        { name: 'Issued by', value: issuerId ? `<@${issuerId}>` : issuerTag, inline: true },
        { name: 'Active strikes', value: `${strikeMeter(count)} ${count}`, inline: true },
        { name: 'Reason', value: truncate(reason, 1024) },
      ).setFooter(footer(`Strike #${strike.id}`, client))],
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
    embeds: [new EmbedBuilder().setColor(COLORS.accepted).setAuthor({ name: '✅ Strike removed' }).setTitle(`Strike removed · ${target.user_tag}`)
      .setDescription(`Strike #${target.id} was removed by ${byTag}.\n<@${target.user_id}> now has ${strikeMeter(count)} **${count}** active strike${count === 1 ? '' : 's'}.`)
      .setFooter(footer(`Strike #${target.id}`, client))],
  });
  return { ok: true, count, strike: target, notes };
}

/* ---------- LOA ---------- */

/** Approved LOAs kept in memory so the daily start/end check doesn't wake the database. */
const loaSchedule = new Map(); // id -> { id, user_id, start_date, end_date, role_applied }

/** What an LOA looks like right now: { icon, text, color, active, onLeave }. */
function loaState(loa, today) {
  const early = loa.ended_at && loa.status === 'ended' && toDateStr(loa.ended_at) < loa.end_date;
  if (loa.status === 'approved') {
    return loa.role_applied || loa.start_date <= today
      ? { icon: '🌴', text: `On leave until ${prettyDate(loa.end_date)}`, color: COLORS.sky, active: true, onLeave: true }
      : { icon: '📅', text: `Starts ${prettyDate(loa.start_date)}`, color: COLORS.brand, active: true, onLeave: false };
  }
  if (loa.status === 'ended') {
    return early
      ? { icon: '👋', text: `Came back early on ${prettyDate(toDateStr(loa.ended_at))}`, color: COLORS.accepted }
      : { icon: '👋', text: 'Back from leave', color: COLORS.accepted };
  }
  if (loa.status === 'pending') return { icon: '⏳', text: 'Waiting', color: COLORS.pending, active: true };
  if (loa.status === 'cancelled') return { icon: '🚫', text: 'Cancelled', color: COLORS.muted };
  return { icon: '❌', text: 'Denied', color: COLORS.denied };
}

/** YYYY-MM-DD for a timestamp, in UTC (good enough for "came back early on"). */
function toDateStr(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export function loaCard(loa, today) {
  const st = loaState(loa, today);
  const embed = new EmbedBuilder().setColor(st.color).setAuthor({ name: '🌴 Leave of absence' }).setTitle(truncate(loa.user_tag, 256))
    .setDescription(`${st.icon} **${st.text}**`)
    .addFields(
      { name: 'Member', value: `<@${loa.user_id}>`, inline: true },
      { name: 'From', value: `📅 ${prettyDate(loa.start_date)}`, inline: true },
      { name: 'Until', value: `📅 ${prettyDate(loa.end_date)}`, inline: true },
      { name: 'Reason', value: truncate(loa.reason || '(none)', 1024) },
    ).setFooter(footer(`LOA #${loa.id}${st.active ? ' · only they (or a manager) can use the button' : ''}`, client));
  const components = st.active ? [new ActionRowBuilder().addComponents(
    st.onLeave
      ? new ButtonBuilder().setCustomId(`loa:back:${loa.id}`).setLabel("I'm back early").setEmoji('👋').setStyle(ButtonStyle.Primary)
      : new ButtonBuilder().setCustomId(`loa:back:${loa.id}`).setLabel('Cancel this LOA').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
  )] : [];
  return { embeds: [embed], components, allowedMentions: { users: [] } };
}

async function refreshLoaCard(loa, settingsArg) {
  if (!loa?.message_channel_id || !loa.message_id) return;
  try {
    const settings = settingsArg || await getSettings();
    const ch = await client.channels.fetch(loa.message_channel_id);
    const msg = await ch.messages.fetch(loa.message_id);
    await msg.edit(loaCard(loa, todayIn(settings.timezone)));
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
    return `Could not change the LOA role (${err.message}). In Server Settings → Roles, drag the bot's role above the LOA role.`;
  }
}

/** Gives the LOA role now if the leave has started. Returns a note for the person, or null. */
async function applyIfStarted(loa, settings) {
  const today = todayIn(settings.timezone);
  if (loa.start_date > today) return `Your LOA role will be added on ${prettyDate(loa.start_date)}.`;
  const problem = await setLoaRole(loa.user_id, true, settings);
  if (problem) { console.warn(`[loa] #${loa.id}:`, problem); return problem; }
  const e = loaSchedule.get(loa.id);
  if (e) e.role_applied = true;
  await updateLoa(loa.id, { role_applied: true });
  return 'You have the LOA role now.';
}

/**
 * Requests are approved on their own (no manager step): the LOA is set right away,
 * the role is given on the first day, and a card is posted in the LOA channel.
 * Returns { ok, error?, loa, notes[] }.
 */
export async function requestLoa({ userId, userTag, start, end, reason }) {
  const settings = await getSettings();
  const tz = settings.timezone;
  const startDate = parseDateInput(start, tz);
  const endDate = parseDateInput(end, tz);
  if (!startDate || !endDate) return { ok: false, error: 'Use dates like 2026-11-03, 11/03, today or tomorrow.' };
  if (endDate < startDate) return { ok: false, error: 'The last day must be on or after the first day.' };
  if (endDate < todayIn(tz)) return { ok: false, error: 'Those dates are already in the past.' };
  const open = await findOpenLoa(userId);
  if (open) return { ok: false, error: `You already have an LOA (${prettyDate(open.start_date)} to ${prettyDate(open.end_date)}). Use /loa view to see it or end it.` };

  const created = await createLoa({ userId, userTag, startDate, endDate, reason: truncate(reason?.trim() || '', 500) });
  let loa = await decideLoaRow(created.id, 'approved', null, 'Automatic');
  loaSchedule.set(loa.id, { id: loa.id, user_id: loa.user_id, start_date: loa.start_date, end_date: loa.end_date, role_applied: false });
  const notes = [await applyIfStarted(loa, settings)].filter(Boolean);
  loa = await getLoa(loa.id);
  const today = todayIn(tz);

  if (settings.loa_channel_id) {
    try {
      const ch = await client.channels.fetch(settings.loa_channel_id);
      const msg = await ch.send(loaCard(loa, today));
      loa = await updateLoa(loa.id, { message_channel_id: ch.id, message_id: msg.id });
    } catch (err) {
      console.warn('[loa] could not post to the LOA channel:', err.message);
      notes.push('It could not be posted in the LOA channel (the bot needs View Channel, Send Messages and Embed Links there).');
    }
  }
  try {
    const user = await client.users.fetch(loa.user_id);
    await user.send(loaCard(loa, today));
  } catch { /* DMs closed */ }
  return { ok: true, loa, notes };
}

/** Old manager approval (kept for LOAs that were waiting before approval was removed). */
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
    notes.push(await applyIfStarted(loa, settings));
  }
  await refreshLoaCard(await getLoa(loa.id), settings);
  return { ok: true, loa, notes: notes.filter(Boolean) };
}

/** Back early (or cancel one that hasn't started). Removes the LOA role. */
export async function endLoa({ id, byTag }) {
  const settings = await getSettings();
  const loa = await getLoa(id);
  if (!loa || !['pending', 'approved'].includes(loa.status)) return { ok: false, error: 'That LOA is already over.' };
  const started = loa.status === 'approved' && (loa.role_applied || loa.start_date <= todayIn(settings.timezone));
  const status = started ? 'ended' : 'cancelled';
  const notes = [];
  if (loa.role_applied || loaSchedule.get(id)?.role_applied || started) {
    const problem = await setLoaRole(loa.user_id, false, settings);
    if (problem && settings.loa_role_id) notes.push(problem);
  }
  loaSchedule.delete(id);
  const updated = await updateLoa(id, { status, role_applied: false, ended_at: new Date(), reviewed_by_tag: loa.reviewed_by_tag || byTag });
  await refreshLoaCard(updated, settings);
  return { ok: true, loa: updated, notes };
}

/** Adds the LOA role on the first day and removes it after the last day. Runs from memory. */
export async function runLoaSchedule(settingsArg) {
  if (!loaSchedule.size) return;
  const settings = settingsArg || await getSettings();
  const today = todayIn(settings.timezone);
  for (const e of [...loaSchedule.values()]) {
    if (today > e.end_date) {
      if (e.role_applied) await setLoaRole(e.user_id, false, settings);
      const updated = await updateLoa(e.id, { status: 'ended', role_applied: false, ended_at: new Date() });
      loaSchedule.delete(e.id);
      await refreshLoaCard(updated, settings);
      try {
        (await client.users.fetch(e.user_id)).send({ embeds: [notice('Welcome back! 👋 Your LOA has ended and the LOA role was removed.', 'success')] });
      } catch { /* ignore */ }
    } else if (!e.role_applied && today >= e.start_date) {
      const note = await setLoaRole(e.user_id, true, settings);
      if (note) { console.warn(`[loa] #${e.id}:`, note); continue; }
      e.role_applied = true;
      await refreshLoaCard(await updateLoa(e.id, { role_applied: true }), settings);
    }
  }
}

export async function loadLoaSchedule() {
  // Approval was removed: anything still waiting is approved now
  for (const l of await listLoas({ status: 'pending' })) {
    const loa = await decideLoaRow(l.id, 'approved', null, 'Automatic');
    if (loa) await refreshLoaCard(loa);
  }
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
      { type: ApplicationCommandOptionType.Subcommand, name: 'request', description: 'Go on leave (you get the LOA role on your first day)' },
      { type: ApplicationCommandOptionType.Subcommand, name: 'view', description: 'See your LOA, with a button to come back early' },
      { type: ApplicationCommandOptionType.Subcommand, name: 'end', description: "I'm back early: end your LOA now (or cancel an upcoming one)" },
    ],
  },
];

export async function registerCommands(guild) {
  try {
    await guild.commands.set([...commandData, ...communityCommandData, ...levelCommandData]);
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
        return interaction.reply({ ...say('Only staff can see other people\'s strikes.', 'blocked'), flags: ephemeral });
      }
      const list = await listStrikes({ userId: who.id });
      const active = list.filter((s) => !s.revoked_at);
      const lines = list.slice(0, 15).map((s) => `${s.revoked_at ? '~~' : ''}#${s.id} · <t:${unix(s.created_at)}:d> · ${truncate(s.reason, 120)} (by ${s.issued_by_tag})${s.revoked_at ? '~~ removed' : ''}`);
      const embed = new EmbedBuilder().setColor(active.length ? COLORS.denied : COLORS.accepted).setAuthor({ name: '⚠️ Strikes' })
        .setTitle(truncate(who.tag, 256))
        .setDescription(truncate(`${strikeMeter(active.length)} **${active.length}** active strike${active.length === 1 ? '' : 's'}\n\n${lines.join('\n') || 'No strikes. 🎉'}`, 4096))
        .setFooter(footer(null, client));
      return interaction.reply({ embeds: [embed], flags: ephemeral, allowedMentions: { users: [] } });
    }
    if (!isManager(interaction.member, settings)) return interaction.reply({ ...say('Only managers can give or remove strikes.', 'blocked'), flags: ephemeral });
    if (target.bot) return interaction.reply({ ...say("Bots can't get strikes.", 'error'), flags: ephemeral });
    await interaction.deferReply({ flags: ephemeral });
    if (sub === 'add') {
      const r = await issueStrike({ userId: target.id, userTag: target.tag, reason: interaction.options.getString('reason'), issuerId: interaction.user.id, issuerTag: interaction.user.tag });
      return interaction.editReply(r.ok ? say(`Gave ${target} strike ${r.count}. ${strikeMeter(r.count)}\n${r.notes.join(' ')}`, 'success') : say(r.error, 'error'));
    }
    const r = await removeStrike({ userId: target.id, byTag: interaction.user.tag });
    return interaction.editReply(r.ok ? say(`Removed a strike. ${target} now has ${r.count}. ${strikeMeter(r.count)}\n${r.notes.join(' ')}`, 'success') : say(r.error, 'error'));
  }

  if (interaction.commandName === 'loa') {
    if (!isStaff(interaction.member, settings) && !isManager(interaction.member, settings)) {
      return interaction.reply({ ...say('LOA requests are for staff.', 'blocked'), flags: ephemeral });
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
    if (!open) return interaction.reply({ ...say("You don't have an LOA right now. Use `/loa request` to go on leave.", 'info'), flags: ephemeral });
    if (sub === 'view') {
      return interaction.reply({ ...loaCard(open, todayIn(settings.timezone)), flags: ephemeral });
    }
    await interaction.deferReply({ flags: ephemeral });
    const r = await endLoa({ id: open.id, byTag: interaction.user.tag });
    return interaction.editReply(r.ok ? say(backText(r), 'success') : say(r.error, 'error'));
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
  if (!r.ok) return interaction.editReply(say(r.error, 'error'));
  return interaction.editReply(say(`🌴 You're on LOA from **${prettyDate(r.loa.start_date)}** to **${prettyDate(r.loa.end_date)}**.\n${r.notes.join('\n')}\n\nCome back early any time with \`/loa view\` or the button in your DMs.`, 'success'));
}

/** "Welcome back" / "cancelled" text after ending an LOA. */
function backText(r) {
  const base = r.loa.status === 'cancelled' ? 'Your upcoming LOA was cancelled.' : 'Welcome back! 👋 Your LOA has ended and the LOA role was removed.';
  return [base, ...(r.notes || [])].join('\n');
}

/** Buttons on LOA cards: loa:back:<id> (the member, or a manager). Old loa:approve / loa:deny still work. */
export async function handleLoaButton(interaction) {
  const [, action, id] = interaction.customId.split(':');
  const settings = await getSettings();
  if (action === 'back') {
    const loa = await getLoa(Number(id));
    if (!loa) return interaction.reply({ ...say('That LOA no longer exists.', 'info'), flags: ephemeral });
    const own = loa.user_id === interaction.user.id;
    if (!own && !isManager(interaction.member, settings)) {
      return interaction.reply({ ...say('Only the person on leave (or a manager) can use this button.', 'blocked'), flags: ephemeral });
    }
    const r = await endLoa({ id: loa.id, byTag: interaction.user.tag || interaction.user.username });
    if (!r.ok) return interaction.reply({ ...say(r.error, 'info'), flags: ephemeral });
    // The card in the LOA channel was refreshed by endLoa. A DM or /loa view card is updated in place.
    if (interaction.message && interaction.message.id !== loa.message_id) {
      await interaction.update(loaCard(r.loa, todayIn(settings.timezone)));
      return interaction.followUp({ ...say(own ? backText(r) : `Ended <@${loa.user_id}>'s LOA.`, 'success'), flags: ephemeral }).catch(() => {});
    }
    return interaction.reply({ ...say(own ? backText(r) : `Ended <@${loa.user_id}>'s LOA and removed the role.`, 'success'), flags: ephemeral });
  }
  if (!isManager(interaction.member, settings)) return interaction.reply({ ...say('Only managers can do that.', 'blocked'), flags: ephemeral });
  await interaction.deferReply({ flags: ephemeral });
  const r = await decideLoa({ id: Number(id), approve: action === 'approve', byId: interaction.user.id, byTag: interaction.user.tag });
  return interaction.editReply(r.ok ? say(`${action === 'approve' ? 'Approved' : 'Denied'}. ${r.notes.join(' ')}`, 'success') : say(r.error, 'error'));
}

export const _staffState = { loaSchedule };
