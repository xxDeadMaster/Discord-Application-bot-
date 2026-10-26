import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder,
  PermissionFlagsBits, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  addTicketMessage, closeTicket, createTicket, deleteTicket, findOpenTicketForUser, getSettings, getTicket,
  getTicketType, listTicketMessages, listTicketTypes, query, setTicketChannel, updateTicket,
} from '../db.js';
import { config } from '../config.js';
import { client, getGuild } from './client.js';
import { COLORS, dashboardLink, ephemeral, isStaff, truncate, unix } from './ui.js';

/**
 * Open tickets, keyed by channel ID, kept in memory so messages and the inactivity check
 * don't need a database lookup (lets Neon's free database sleep).
 * { ticketId, last: ms of last human message, warnedAt: ms | null }
 */
const openTickets = new Map();
let autoCloseHours = 48;
const WARNING_GRACE_MS = 60 * 60 * 1000; // after the warning, close if still quiet for 1 hour
export const DEFAULT_QUESTION = 'What do you need help with?';

const pad = (n) => String(n).padStart(4, '0');
const slug = (t) => String(t).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'ticket';

/** Called at startup and whenever settings are saved on the dashboard. */
export function setTicketSettings(settings) {
  autoCloseHours = Number(settings?.auto_close_hours ?? 48);
}

export async function loadOpenTickets() {
  const settings = await getSettings();
  setTicketSettings(settings);
  const { rows } = await query(
    `SELECT t.id, t.channel_id, t.created_at,
            (SELECT max(m.created_at) FROM ticket_messages m WHERE m.ticket_id = t.id AND NOT m.is_bot) AS last_human
       FROM tickets t WHERE t.guild_id = $1 AND t.status = 'open' AND t.channel_id IS NOT NULL`,
    [config.guildId],
  );
  for (const t of rows) {
    const channel = await client.channels.fetch(t.channel_id).catch(() => null);
    if (channel) {
      openTickets.set(t.channel_id, { ticketId: t.id, last: new Date(t.last_human || t.created_at).getTime(), warnedAt: null });
    } else {
      await closeTicket(t.id, null, 'Channel deleted'); // deleted while the bot was offline
    }
  }
  console.log(`[tickets] tracking ${openTickets.size} open ticket(s)`);
}

/* ---------- Welcome card in the ticket channel ---------- */

export function ticketCard(ticket, opener) {
  const answers = Array.isArray(ticket.answers) && ticket.answers.length ? ticket.answers : [{ q: 'Topic', a: ticket.topic }];
  const embed = new EmbedBuilder()
    .setColor(ticket.claimed_by ? COLORS.accepted : COLORS.brand)
    .setTitle(truncate(`Ticket #${pad(ticket.number)}${ticket.type_name ? ` · ${ticket.type_name}` : ''}`, 256))
    .setDescription(`Thanks for reaching out, ${opener || `<@${ticket.opener_id}>`}. Staff will be with you soon.`)
    .addFields(
      ...answers.slice(0, 5).map((x) => ({ name: truncate(x.q, 256), value: truncate(x.a || '(no answer)', 1024) })),
      { name: 'Claimed by', value: ticket.claimed_by ? `<@${ticket.claimed_by}> <t:${unix(ticket.claimed_at)}:R>` : 'Nobody yet' },
    )
    .setFooter({ text: 'Everything in this channel is saved to the ticket transcript.' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:claim').setLabel(ticket.claimed_by ? 'Unclaim' : 'Claim').setStyle(ticket.claimed_by ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

async function refreshWelcome(ticket) {
  if (!ticket.channel_id || !ticket.welcome_message_id) return;
  try {
    const channel = await client.channels.fetch(ticket.channel_id);
    const msg = await channel.messages.fetch(ticket.welcome_message_id);
    await msg.edit(ticketCard(ticket));
  } catch (err) {
    console.warn('[tickets] could not update ticket card:', err.message);
  }
}

/* ---------- Opening ---------- */

function questionModal(type) {
  const questions = (type?.questions?.length ? type.questions : [DEFAULT_QUESTION]).slice(0, 5);
  const modal = new ModalBuilder()
    .setCustomId(`ticket:openmodal:${type?.id || 0}`)
    .setTitle(truncate(type ? `Open a ticket · ${type.name}` : 'Open a ticket', 45));
  questions.forEach((q, i) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${i}`)
      .setLabel(truncate(q, 45))
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(i === 0)
      .setMaxLength(1000);
    if (q.length > 45) input.setPlaceholder(truncate(q, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });
  return modal;
}

async function alreadyOpen(interaction) {
  const existing = await findOpenTicketForUser(interaction.user.id);
  if (existing?.channel_id) {
    await interaction.reply({ content: `You already have an open ticket: <#${existing.channel_id}>`, flags: ephemeral });
    return true;
  }
  return false;
}

export async function handleOpenButton(interaction) {
  if (await alreadyOpen(interaction)) return;
  return interaction.showModal(questionModal(null));
}

export async function handleTypeSelect(interaction) {
  // Reset the public panel's dropdown so it doesn't look stuck on a choice
  interaction.message.edit({ components: interaction.message.components }).catch(() => {});
  if (await alreadyOpen(interaction)) return;
  const type = await getTicketType(Number(interaction.values[0]));
  if (!type || !type.enabled) return interaction.reply({ content: 'That ticket type is not available anymore.', flags: ephemeral });
  return interaction.showModal(questionModal(type));
}

export async function handleOpenModal(interaction) {
  await interaction.deferReply({ flags: ephemeral });
  const settings = await getSettings();
  const user = interaction.user;
  const typeId = Number(interaction.customId.split(':')[2]) || 0;
  const type = typeId ? await getTicketType(typeId) : null;
  const questions = (type?.questions?.length ? type.questions : [DEFAULT_QUESTION]).slice(0, 5);
  const answers = questions.map((q, i) => {
    let a = '';
    try { a = interaction.fields.getTextInputValue(`q${i}`)?.trim() || ''; } catch { /* optional field left out */ }
    return { q, a };
  });
  const topic = answers[0]?.a || '(no topic)';

  const existing = await findOpenTicketForUser(user.id);
  if (existing?.channel_id) return interaction.editReply(`You already have an open ticket: <#${existing.channel_id}>`);

  const guild = await getGuild();
  const ticket = await createTicket({ openerId: user.id, openerTag: user.tag, topic, typeId: type?.id || null, typeName: type?.name || null, answers });

  const perms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: perms },
    { id: client.user.id, allow: [...perms, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
  ];
  const staffRoles = [...new Set([type?.staff_role_id, settings.staff_role_id].filter(Boolean))];
  for (const id of staffRoles) overwrites.push({ id, allow: [...perms, PermissionFlagsBits.ManageMessages] });

  let channel;
  try {
    channel = await guild.channels.create({
      name: `${type ? slug(type.name) : 'ticket'}-${pad(ticket.number)}`,
      type: ChannelType.GuildText,
      parent: type?.category_id || settings.ticket_category_id || undefined,
      topic: truncate(`Ticket #${pad(ticket.number)}${type ? ` · ${type.name}` : ''} · opened by ${user.tag} · ${topic}`, 1024),
      permissionOverwrites: overwrites,
      reason: `Ticket opened by ${user.tag}`,
    });
  } catch (err) {
    await deleteTicket(ticket.id);
    console.error('[tickets] could not create channel:', err);
    return interaction.editReply('I could not create your ticket channel. Please tell a staff member (the bot needs Manage Channels and Manage Roles).');
  }

  await setTicketChannel(ticket.id, channel.id);
  ticket.channel_id = channel.id;
  openTickets.set(channel.id, { ticketId: ticket.id, last: Date.now(), warnedAt: null });

  const msg = await channel.send({
    content: [`${user}`, ...staffRoles.map((id) => `<@&${id}>`)].join(' '),
    ...ticketCard(ticket, `${user}`),
    allowedMentions: { users: [user.id], roles: staffRoles },
  });
  await updateTicket(ticket.id, { welcome_message_id: msg.id });

  return interaction.editReply(`Your ticket is open: ${channel}`);
}

/* ---------- Claiming ---------- */

function isManager(member, settings) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(settings.manager_role_id && member.roles?.cache?.has(settings.manager_role_id));
}

/** Claim or unclaim. Returns { ok, error?, ticket?, claimed: boolean }. */
export async function toggleClaim({ ticketId, userId, userTag, member, settings }) {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== 'open') return { ok: false, error: 'This ticket is closed.' };
  const type = ticket.type_id ? await getTicketType(ticket.type_id) : null;
  const allowed = member === 'dashboard'
    || isStaff(member, settings)
    || Boolean(type?.staff_role_id && member?.roles?.cache?.has(type.staff_role_id));
  if (!allowed) return { ok: false, error: 'Only staff can claim tickets.' };

  if (ticket.claimed_by && ticket.claimed_by !== userId) {
    if (member !== 'dashboard' && !isManager(member, settings)) return { ok: false, error: `<@${ticket.claimed_by}> already claimed this ticket.` };
  }
  const unclaim = ticket.claimed_by === userId;
  const updated = await updateTicket(ticket.id, unclaim
    ? { claimed_by: null, claimed_by_tag: null, claimed_at: null }
    : { claimed_by: userId, claimed_by_tag: userTag, claimed_at: new Date() });
  await refreshWelcome(updated);
  const channel = ticket.channel_id ? await client.channels.fetch(ticket.channel_id).catch(() => null) : null;
  await channel?.send({
    content: unclaim ? `<@${userId}> unclaimed this ticket. Another staff member can pick it up.` : `<@${userId}> claimed this ticket and will help you.`,
    allowedMentions: { users: [] },
  }).catch(() => {});
  return { ok: true, ticket: updated, claimed: !unclaim };
}

export async function handleClaimButton(interaction) {
  const entry = openTickets.get(interaction.channelId);
  if (!entry) return interaction.reply({ content: 'This ticket is already closed.', flags: ephemeral });
  const settings = await getSettings();
  const r = await toggleClaim({ ticketId: entry.ticketId, userId: interaction.user.id, userTag: interaction.user.tag, member: interaction.member, settings });
  return interaction.reply({ content: r.ok ? (r.claimed ? 'You claimed this ticket.' : 'You unclaimed this ticket.') : r.error, flags: ephemeral });
}

/* ---------- Recording messages + inactivity ---------- */

export async function recordTicketMessage(message) {
  const entry = openTickets.get(message.channelId);
  if (!entry) return;
  if (!message.author.bot) {
    entry.last = message.createdTimestamp || Date.now();
    entry.warnedAt = null;
  }
  const embedText = message.embeds
    .map((e) => [e.title, e.description, ...e.fields.map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join(' | '))
    .filter(Boolean);
  const content = [message.content, ...embedText.map((t) => `[embed] ${t}`)].filter(Boolean).join('\n');
  await addTicketMessage(entry.ticketId, {
    authorId: message.author.id,
    authorTag: message.author.tag,
    isBot: message.author.bot,
    content,
    attachments: [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
    createdAt: message.createdAt,
  });
}

export async function handleKeepOpen(interaction) {
  const entry = openTickets.get(interaction.channelId);
  if (!entry) return interaction.update({ content: 'This ticket is already closed.', components: [] });
  entry.last = Date.now();
  entry.warnedAt = null;
  return interaction.update({ content: `${interaction.user} kept this ticket open.`, components: [], allowedMentions: { users: [] } });
}

/** One pass of the inactivity check. Runs from memory; only touches the database to close. */
export async function checkInactiveTickets(now = Date.now()) {
  if (!autoCloseHours || autoCloseHours <= 0) return;
  const limit = autoCloseHours * 60 * 60 * 1000;
  for (const [channelId, entry] of openTickets) {
    if (!entry.warnedAt && now - entry.last >= limit) {
      entry.warnedAt = now;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      await channel?.send({
        content: `This ticket has had no messages for ${autoCloseHours} hour${autoCloseHours === 1 ? '' : 's'}. It will close automatically in 1 hour unless someone replies.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket:keepopen').setLabel('Keep it open').setStyle(ButtonStyle.Secondary),
        )],
      }).catch(() => {});
    } else if (entry.warnedAt && now - entry.warnedAt >= WARNING_GRACE_MS && entry.last < entry.warnedAt) {
      const ticket = await closeTicket(entry.ticketId, null, 'Auto-close (inactive)');
      if (ticket) await finishClose(ticket);
      else openTickets.delete(channelId);
    }
  }
}

export function startAutoClose() {
  return setInterval(() => checkInactiveTickets().catch((e) => console.warn('[tickets] auto-close check failed:', e.message)), 5 * 60 * 1000);
}

/* ---------- Closing ---------- */

export async function handleCloseButton(interaction) {
  if (!openTickets.has(interaction.channelId)) {
    return interaction.reply({ content: 'This ticket is already closed.', flags: ephemeral });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:closeconfirm').setLabel('Yes, close it').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket:closecancel').setLabel('Keep it open').setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({ content: 'Close this ticket? The channel will be deleted and a transcript saved.', components: [row], flags: ephemeral });
}

export async function handleCloseCancel(interaction) {
  return interaction.update({ content: 'Okay, the ticket stays open.', components: [] });
}

export function transcriptText(ticket, messages) {
  const lines = [
    `Ticket #${pad(ticket.number)}${ticket.type_name ? ` (${ticket.type_name})` : ''}`,
    `Opened by: ${ticket.opener_tag} (${ticket.opener_id})`,
    `Topic: ${ticket.topic}`,
    `Claimed by: ${ticket.claimed_by_tag || 'nobody'}`,
    `Opened: ${new Date(ticket.created_at).toISOString()}`,
    `Closed: ${ticket.closed_at ? new Date(ticket.closed_at).toISOString() : 'still open'}${ticket.closed_by_tag ? ` by ${ticket.closed_by_tag}` : ''}`,
    '',
    '----------------------------------------',
    '',
  ];
  for (const m of messages) {
    const time = new Date(m.created_at).toISOString().replace('T', ' ').slice(0, 16);
    lines.push(`[${time} UTC] ${m.author_tag}${m.is_bot ? ' [BOT]' : ''}: ${m.content}`);
    for (const a of m.attachments || []) lines.push(`    attachment: ${a.name} ${a.url}`);
  }
  if (!messages.length) lines.push('(no messages)');
  return lines.join('\n');
}

function ratingRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map((n) => new ButtonBuilder().setCustomId(`trate:${ticketId}:${n}`).setLabel(`${n} ★`).setStyle(n >= 4 ? ButtonStyle.Success : ButtonStyle.Secondary)),
  );
}

async function finishClose(ticket, { deleteChannel = true } = {}) {
  openTickets.delete(ticket.channel_id);
  const settings = await getSettings();
  const messages = await listTicketMessages(ticket.id);
  const file = new AttachmentBuilder(Buffer.from(transcriptText(ticket, messages), 'utf8'), { name: `ticket-${pad(ticket.number)}.txt` });
  const link = dashboardLink(`/tickets/${ticket.id}`);

  if (settings.ticket_log_channel_id) {
    try {
      const log = await client.channels.fetch(settings.ticket_log_channel_id);
      const embed = new EmbedBuilder()
        .setColor(COLORS.muted)
        .setTitle(truncate(`Ticket #${pad(ticket.number)} closed${ticket.type_name ? ` · ${ticket.type_name}` : ''}`, 256))
        .setURL(link.startsWith('https://') ? link : null)
        .addFields(
          { name: 'Opened by', value: `<@${ticket.opener_id}> (${ticket.opener_tag})`, inline: true },
          { name: 'Claimed by', value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'Nobody', inline: true },
          { name: 'Closed by', value: ticket.closed_by ? `<@${ticket.closed_by}>` : (ticket.closed_by_tag || 'Unknown'), inline: true },
          { name: 'Opened', value: `<t:${unix(ticket.created_at)}:f>`, inline: true },
          { name: 'Closed', value: `<t:${unix(ticket.closed_at)}:f>`, inline: true },
          { name: 'Messages', value: String(messages.length), inline: true },
          { name: 'Topic', value: truncate(ticket.topic || '(none)', 1024) },
        );
      await log.send({ embeds: [embed], files: [file] });
    } catch (err) {
      console.warn('[tickets] could not post to log channel:', err.message);
    }
  }

  try {
    const opener = await client.users.fetch(ticket.opener_id);
    await opener.send({
      content: `Your ticket **#${pad(ticket.number)}** was closed. Here's a copy of the conversation.\n\n**How did we do?** Tap a rating from 1 (bad) to 5 (great).`,
      files: [file],
      components: [ratingRow(ticket.id)],
    });
  } catch { /* DMs closed: fine */ }

  if (deleteChannel && ticket.channel_id) {
    const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
    if (channel) {
      await channel.send('Closing this ticket in 5 seconds…').catch(() => {});
      setTimeout(() => channel.delete(`Ticket #${pad(ticket.number)} closed`).catch((e) => console.warn('[tickets] delete failed:', e.message)), 5000);
    }
  }
}

/** Rating buttons in the closing DM: trate:<ticketId>:<1-5> */
export async function handleRating(interaction) {
  const [, id, n] = interaction.customId.split(':');
  const rating = Number(n);
  const ticket = await getTicket(Number(id));
  if (!ticket || ticket.opener_id !== interaction.user.id || !(rating >= 1 && rating <= 5)) {
    return interaction.reply({ content: 'This rating is not for you.', flags: ephemeral });
  }
  if (ticket.rating) {
    return interaction.update({ content: `${interaction.message.content.split('\n\n')[0]}\n\nYou already rated this ticket ${ticket.rating}/5. Thanks!`, components: [] });
  }
  await updateTicket(ticket.id, { rating, rated_at: new Date() });
  return interaction.update({ content: `${interaction.message.content.split('\n\n')[0]}\n\nThanks for rating us **${rating}/5**!`, components: [] });
}

export async function handleCloseConfirm(interaction) {
  const entry = openTickets.get(interaction.channelId);
  if (!entry) return interaction.update({ content: 'This ticket is already closed.', components: [] });
  await interaction.update({ content: 'Closing the ticket…', components: [] });
  const ticket = await closeTicket(entry.ticketId, interaction.user.id, interaction.user.tag);
  if (!ticket) return;
  await finishClose(ticket);
}

/** Someone deleted a ticket channel by hand: close it and keep the transcript. */
export async function handleChannelDelete(channel) {
  const entry = openTickets.get(channel.id);
  if (!entry) return;
  const ticket = await closeTicket(entry.ticketId, null, 'Channel deleted');
  if (ticket) await finishClose(ticket, { deleteChannel: false });
}

/** Close from the website. */
export async function closeTicketFromDashboard(ticketId, userId, userTag) {
  const ticket = await closeTicket(ticketId, userId, userTag);
  if (!ticket) return { ok: false, error: 'That ticket is already closed.' };
  await finishClose(ticket);
  return { ok: true };
}

/** Ticket panel: a dropdown of ticket types, or a single button when there are none. */
export async function ticketPanelComponents() {
  const types = (await listTicketTypes({ enabledOnly: true })).slice(0, 25);
  if (!types.length) {
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:open').setLabel('Open a ticket').setStyle(ButtonStyle.Primary))];
  }
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('ticket:type').setPlaceholder('What do you need help with?').addOptions(types.map((t) => {
      const o = { label: truncate(t.name, 100), value: String(t.id) };
      if (t.description) o.description = truncate(t.description, 100);
      return o;
    })),
  )];
}

export const _ticketState = { openTickets };
