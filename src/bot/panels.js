import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { getSettings, listCategories, listRoles, updateSettings } from '../db.js';
import { client } from './client.js';
import { COLORS, truncate } from './ui.js';

/** Categories that have at least one open role with questions. */
async function usableCategories() {
  const cats = await listCategories({ enabledOnly: true });
  const out = [];
  for (const c of cats) {
    const roles = (await listRoles(c.id, { enabledOnly: true })).filter((r) => r.question_count > 0);
    if (roles.length) out.push(c);
  }
  return out.slice(0, 25);
}

export async function buildApplyPanel(settings) {
  const cats = await usableCategories();
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(settings.apply_panel_title, 256))
    .setDescription(truncate(settings.apply_panel_description, 4000));

  if (!cats.length) {
    embed.addFields({ name: 'Applications are closed', value: 'Nothing is open right now. Check back later.' });
    return { embeds: [embed], components: [] };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('apply:category')
    .setPlaceholder('Choose an application type')
    .addOptions(cats.map((c) => {
      const opt = { label: truncate(c.name, 100), value: String(c.id) };
      if (c.description) opt.description = truncate(c.description, 100);
      return opt;
    }));

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

export function buildTicketPanel(settings) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(settings.ticket_panel_title, 256))
    .setDescription(truncate(settings.ticket_panel_description, 4000));
  const button = new ButtonBuilder().setCustomId('ticket:open').setLabel('Open a ticket').setStyle(ButtonStyle.Primary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

/**
 * Sends the panel to its channel, or edits the existing panel message in place.
 * kind: 'apply' | 'ticket'. Throws an Error with a readable message on failure.
 */
export async function publishPanel(kind) {
  const settings = await getSettings();
  const channelKey = kind === 'apply' ? 'apply_channel_id' : 'ticket_channel_id';
  const messageKey = kind === 'apply' ? 'apply_panel_message_id' : 'ticket_panel_message_id';
  const channelId = settings[channelKey];
  if (!channelId) throw new Error(`Pick a ${kind === 'apply' ? 'applications' : 'tickets'} channel in Settings first.`);

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('The bot cannot find that channel. Check it still exists and the bot can see it.');

  const payload = kind === 'apply' ? await buildApplyPanel(settings) : buildTicketPanel(settings);

  if (settings[messageKey]) {
    const existing = await channel.messages.fetch(settings[messageKey]).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return { updated: true, channelId };
    }
  }
  try {
    const msg = await channel.send(payload);
    await updateSettings({ [messageKey]: msg.id });
    return { updated: false, channelId };
  } catch (err) {
    throw new Error(`The bot could not post in that channel (${err.message}). Give it View Channel, Send Messages and Embed Links there.`);
  }
}

/** Refreshes the application panel if one is already posted. Errors are logged, not thrown. */
export async function refreshApplyPanelQuietly() {
  try {
    const settings = await getSettings();
    if (settings.apply_channel_id && settings.apply_panel_message_id) await publishPanel('apply');
  } catch (err) {
    console.warn('[panels] could not refresh application panel:', err.message);
  }
}
