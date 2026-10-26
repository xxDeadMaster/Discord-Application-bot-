import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { getSettings, listCategories, listRoles, updateSettings } from '../db.js';
import { client } from './client.js';
import { isCategoryOpen, scheduleState } from '../schedule.js';
import { ticketPanelComponents } from './tickets.js';
import { bannerAttachment } from './banner.js';
import {
  BRAND, COLORS, footer, optionEmoji, truncate, unix, withEmoji,
} from './ui.js';

/** Applications (categories) open right now that have at least one role with questions. */
export async function usableCategories(settings) {
  const tz = settings?.timezone || (await getSettings()).timezone;
  const cats = (await listCategories({ enabledOnly: true })).filter((c) => isCategoryOpen(c, tz));
  const out = [];
  for (const c of cats) {
    const roles = (await listRoles(c.id, { enabledOnly: true })).filter((r) => r.question_count > 0);
    if (roles.length) out.push(c);
  }
  return out.slice(0, 25);
}

/** Embed + banner shared by both panels. */
function panelBase(title, description, subtitle, bannerName) {
  const banner = bannerAttachment(title, subtitle, bannerName);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(title, 256))
    .setDescription(truncate(description, 4000))
    .setFooter(footer(null, client));
  if (banner) embed.setImage(banner.url);
  return { embed, files: banner ? [banner.file] : [] };
}

/** "🟢 Open · closes in 3 hours" / "🟢 Open". Discord shows the time in each reader's own timezone. */
function openLine(category, tz) {
  const { changesAt } = scheduleState(category, tz);
  return changesAt ? `🟢 Open · closes <t:${unix(changesAt)}:R>` : '🟢 Open now';
}

export async function buildApplyPanel(settings) {
  const cats = await usableCategories(settings);
  const tz = settings.timezone;
  const { embed, files } = panelBase(settings.apply_panel_title, settings.apply_panel_description, BRAND, 'applications.png');

  if (!cats.length) {
    embed.setColor(COLORS.muted).addFields({ name: '🔒 Applications are closed', value: 'Nothing is open right now. Check back later!' });
    return { embeds: [embed], components: [], files, attachments: [] };
  }

  embed.addFields(cats.slice(0, 10).map((c) => ({
    name: truncate(withEmoji(c.emoji, c.name), 256),
    value: truncate([c.description, openLine(c, tz)].filter(Boolean).join('\n'), 1024),
    inline: cats.length > 1,
  })));
  embed.addFields({ name: 'How it works', value: '1️⃣ Pick an application below\n2️⃣ Choose the role you want\n3️⃣ Answer the questions in your DMs' });

  const select = new StringSelectMenuBuilder()
    .setCustomId('apply:category')
    .setPlaceholder('📝 Choose an application')
    .addOptions(cats.map((c) => {
      const opt = { label: truncate(c.name, 100), value: String(c.id) };
      if (c.description) opt.description = truncate(c.description, 100);
      if (c.emoji) opt.emoji = optionEmoji(c.emoji);
      return opt;
    }));

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], files, attachments: [] };
}

export async function buildTicketPanel(settings) {
  const { embed, files } = panelBase(settings.ticket_panel_title, settings.ticket_panel_description, 'SUPPORT TICKETS', 'tickets.png');
  embed.setColor(COLORS.sky);
  return { embeds: [embed], components: await ticketPanelComponents(), files, attachments: [] };
}

/** Refreshes the ticket panel if one is already posted (after ticket types change). */
export async function refreshTicketPanelQuietly() {
  try {
    const settings = await getSettings();
    if (settings.ticket_channel_id && settings.ticket_panel_message_id) await publishPanel('ticket');
  } catch (err) {
    console.warn('[panels] could not refresh ticket panel:', err.message);
  }
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

  const payload = kind === 'apply' ? await buildApplyPanel(settings) : await buildTicketPanel(settings);

  if (settings[messageKey]) {
    const existing = await channel.messages.fetch(settings[messageKey]).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      lastSignature = null;
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
  invalidatePanelCache();
  try {
    const settings = await getSettings();
    if (settings.apply_channel_id && settings.apply_panel_message_id) await publishPanel('apply');
  } catch (err) {
    console.warn('[panels] could not refresh application panel:', err.message);
  }
}

/*
 * Every minute, checks whether schedules opened or closed a category and refreshes the
 * posted application panel only when what it should show has changed.
 * Works from an in-memory copy of the roles so the database (Neon's free plan) can sleep;
 * the copy is reloaded only after something is changed on the dashboard.
 */
let cache = null;
let lastSignature = null;

export function invalidatePanelCache() {
  cache = null;
}

async function loadCache() {
  if (cache) return cache;
  const settings = await getSettings();
  const cats = await listCategories({ enabledOnly: true });
  for (const c of cats) c.roles = await listRoles(c.id, { enabledOnly: true });
  cache = { settings, cats };
  return cache;
}

function signatureFrom({ settings, cats }) {
  const tz = settings.timezone;
  const open = cats.filter((c) => isCategoryOpen(c, tz) && c.roles.some((r) => r.question_count > 0)).slice(0, 25);
  return JSON.stringify(open.map((c) => [c.id, c.name, c.description, c.emoji]));
}

export function startPanelScheduler() {
  const tick = async () => {
    try {
      const data = await loadCache();
      if (!data.settings.apply_channel_id || !data.settings.apply_panel_message_id) return;
      const signature = signatureFrom(data);
      if (lastSignature !== null && signature !== lastSignature) {
        await publishPanel('apply');
        console.log('[panels] schedule changed, application panel refreshed');
      }
      lastSignature = signature;
    } catch (err) {
      console.warn('[panels] schedule check failed:', err.message);
    }
  };
  tick();
  return setInterval(tick, 60 * 1000);
}
