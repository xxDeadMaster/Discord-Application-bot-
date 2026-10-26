import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder,
  PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  addTicketMessage, closeTicket, createTicket, deleteTicket, findOpenTicketForUser, getSettings,
  listTicketMessages, query, setTicketChannel,
} from '../db.js';
import { config } from '../config.js';
import { client, getGuild } from './client.js';
import { COLORS, dashboardLink, ephemeral, truncate, unix } from './ui.js';

/** channelId -> ticketId for open tickets, so every message doesn't need a DB lookup. */
const openTickets = new Map();

const pad = (n) => String(n).padStart(4, '0');

export async function loadOpenTickets() {
  const { rows } = await query(
    `SELECT id, channel_id FROM tickets WHERE guild_id = $1 AND status = 'open' AND channel_id IS NOT NULL`,
    [config.guildId],
  );
  for (const t of rows) {
    const channel = await client.channels.fetch(t.channel_id).catch(() => null);
    if (channel) {
      openTickets.set(t.channel_id, t.id);
    } else {
      // Channel was deleted while the bot was offline
      await closeTicket(t.id, null, 'Channel deleted');
    }
  }
  console.log(`[tickets] tracking ${openTickets.size} open ticket(s)`);
}

/* ---------- Opening ---------- */

export async function handleOpenButton(interaction) {
  const existing = await findOpenTicketForUser(interaction.user.id);
  if (existing?.channel_id) {
    return interaction.reply({ content: `You already have an open ticket: <#${existing.channel_id}>`, flags: ephemeral });
  }
  const modal = new ModalBuilder()
    .setCustomId('ticket:openmodal')
    .setTitle('Open a ticket')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('topic')
        .setLabel('What do you need help with?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500),
    ));
  return interaction.showModal(modal);
}

export async function handleOpenModal(interaction) {
  await interaction.deferReply({ flags: ephemeral });
  const settings = await getSettings();
  const user = interaction.user;
  const topic = interaction.fields.getTextInputValue('topic').trim();

  const existing = await findOpenTicketForUser(user.id);
  if (existing?.channel_id) return interaction.editReply(`You already have an open ticket: <#${existing.channel_id}>`);

  const guild = await getGuild();
  const ticket = await createTicket({ openerId: user.id, openerTag: user.tag, topic });

  const perms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: perms },
    { id: client.user.id, allow: [...perms, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
  ];
  if (settings.staff_role_id) overwrites.push({ id: settings.staff_role_id, allow: [...perms, PermissionFlagsBits.ManageMessages] });

  let channel;
  try {
    channel = await guild.channels.create({
      name: `ticket-${pad(ticket.number)}`,
      type: ChannelType.GuildText,
      parent: settings.ticket_category_id || undefined,
      topic: truncate(`Ticket #${pad(ticket.number)} · opened by ${user.tag} · ${topic}`, 1024),
      permissionOverwrites: overwrites,
      reason: `Ticket opened by ${user.tag}`,
    });
  } catch (err) {
    await deleteTicket(ticket.id);
    console.error('[tickets] could not create channel:', err);
    return interaction.editReply('I could not create your ticket channel. Please tell a staff member (the bot needs Manage Channels and Manage Roles).');
  }

  await setTicketChannel(ticket.id, channel.id);
  openTickets.set(channel.id, ticket.id);

  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(`Ticket #${pad(ticket.number)}`)
    .setDescription(`Thanks for reaching out, ${user}. Staff will be with you soon.`)
    .addFields({ name: 'Topic', value: truncate(topic, 1024) })
    .setFooter({ text: 'Everything in this channel is saved to the ticket transcript.' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger),
  );
  await channel.send({
    content: [`${user}`, settings.staff_role_id ? `<@&${settings.staff_role_id}>` : null].filter(Boolean).join(' '),
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [user.id], roles: settings.staff_role_id ? [settings.staff_role_id] : [] },
  });

  return interaction.editReply(`Your ticket is open: ${channel}`);
}

/* ---------- Recording messages ---------- */

export async function recordTicketMessage(message) {
  const ticketId = openTickets.get(message.channelId);
  if (!ticketId) return;
  const embedText = message.embeds
    .map((e) => [e.title, e.description, ...e.fields.map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join(' | '))
    .filter(Boolean);
  const content = [message.content, ...embedText.map((t) => `[embed] ${t}`)].filter(Boolean).join('\n');
  await addTicketMessage(ticketId, {
    authorId: message.author.id,
    authorTag: message.author.tag,
    isBot: message.author.bot,
    content,
    attachments: [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
    createdAt: message.createdAt,
  });
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
    `Ticket #${pad(ticket.number)}`,
    `Opened by: ${ticket.opener_tag} (${ticket.opener_id})`,
    `Topic: ${ticket.topic}`,
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
        .setTitle(`Ticket #${pad(ticket.number)} closed`)
        .setURL(link.startsWith('https://') ? link : null)
        .addFields(
          { name: 'Opened by', value: `<@${ticket.opener_id}> (${ticket.opener_tag})`, inline: true },
          { name: 'Closed by', value: ticket.closed_by ? `<@${ticket.closed_by}>` : (ticket.closed_by_tag || 'Unknown'), inline: true },
          { name: 'Messages', value: String(messages.length), inline: true },
          { name: 'Opened', value: `<t:${unix(ticket.created_at)}:f>`, inline: true },
          { name: 'Closed', value: `<t:${unix(ticket.closed_at)}:f>`, inline: true },
          { name: 'Topic', value: truncate(ticket.topic || '(none)', 1024) },
        );
      await log.send({ embeds: [embed], files: [file] });
    } catch (err) {
      console.warn('[tickets] could not post to log channel:', err.message);
    }
  }

  try {
    const opener = await client.users.fetch(ticket.opener_id);
    await opener.send({ content: `Your ticket **#${pad(ticket.number)}** was closed. Here's a copy of the conversation.`, files: [file] });
  } catch { /* DMs closed: fine */ }

  if (deleteChannel && ticket.channel_id) {
    const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
    if (channel) {
      await channel.send('Closing this ticket in 5 seconds…').catch(() => {});
      setTimeout(() => channel.delete(`Ticket #${pad(ticket.number)} closed`).catch((e) => console.warn('[tickets] delete failed:', e.message)), 5000);
    }
  }
}

export async function handleCloseConfirm(interaction) {
  const ticketId = openTickets.get(interaction.channelId);
  if (!ticketId) return interaction.update({ content: 'This ticket is already closed.', components: [] });
  await interaction.update({ content: 'Closing the ticket…', components: [] });
  const ticket = await closeTicket(ticketId, interaction.user.id, interaction.user.tag);
  if (!ticket) return;
  await finishClose(ticket);
}

/** Someone deleted a ticket channel by hand: close it and keep the transcript. */
export async function handleChannelDelete(channel) {
  const ticketId = openTickets.get(channel.id);
  if (!ticketId) return;
  const ticket = await closeTicket(ticketId, null, 'Channel deleted');
  if (ticket) await finishClose(ticket, { deleteChannel: false });
}

/** Close from the website. */
export async function closeTicketFromDashboard(ticketId, userId, userTag) {
  const ticket = await closeTicket(ticketId, userId, userTag);
  if (!ticket) return { ok: false, error: 'That ticket is already closed.' };
  await finishClose(ticket);
  return { ok: true };
}
