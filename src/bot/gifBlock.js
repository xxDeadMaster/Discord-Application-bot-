// GIF blocker: deletes GIFs (GIF picker / Tenor, Giphy, .gif links and uploads) outside the allowed channels.
// Only the server owner is skipped. Checks messages Orbit already receives, so it costs nothing extra.
import { getSettings } from '../db.js';

let cfg = { enabled: false, allowed: new Set() };
const lastNotice = new Map(); // `${channelId}:${userId}` -> ms (one notice per person per channel every 30s)
const NOTICE_SECONDS = 5;

export async function loadGifBlock() {
  const s = await getSettings();
  cfg = { enabled: Boolean(s.gif_block_enabled), allowed: new Set(s.gif_allowed_channel_ids || []) };
  return cfg;
}

export const gifBlockState = () => ({ enabled: cfg.enabled, allowed: [...cfg.allowed] });

const GIF_LINK = /(?:https?:\/\/)?(?:[\w-]+\.)*(?:tenor\.com|giphy\.com|gfycat\.com|klipy\.com)\/\S+|https?:\/\/\S+?\.gifv?(?:[?#]\S*)?(?=\s|$|>)/i;

/** True when a message contains a GIF in any form. */
export function hasGif(message) {
  if (GIF_LINK.test(message.content || '')) return true;
  for (const a of message.attachments?.values?.() || []) {
    if (a.contentType === 'image/gif' || /\.gif$/i.test(a.name || '') || /\.gif(\?|$)/i.test(a.url || '')) return true;
  }
  for (const e of message.embeds || []) {
    const d = e.data || e;
    if (d.type === 'gifv' || /tenor|giphy/i.test(d.provider?.name || '') || /\.gif(\?|$)/i.test(d.image?.url || d.thumbnail?.url || '')) return true;
  }
  return false;
}

/** Returns true when the message was a GIF and got deleted. */
export async function handleGifMessage(message, now = Date.now()) {
  if (!cfg.enabled || message.author?.bot || !message.guild) return false;
  if (cfg.allowed.has(message.channelId) || cfg.allowed.has(message.channel?.parentId)) return false;
  if (message.author.id === message.guild.ownerId) return false;
  if (!hasGif(message)) return false;
  await message.delete().catch(() => {});
  const key = `${message.channelId}:${message.author.id}`;
  if (now - (lastNotice.get(key) || 0) > 30_000) {
    lastNotice.set(key, now);
    const where = [...cfg.allowed].map((id) => `<#${id}>`).join(' or ');
    const note = await message.channel.send({
      content: `🚫 ${message.author}, GIFs aren't allowed here.${where ? ` Post them in ${where}.` : ''}`,
      allowedMentions: { users: [message.author.id] },
    }).catch(() => null);
    if (note) setTimeout(() => note.delete().catch(() => {}), NOTICE_SECONDS * 1000).unref?.();
  }
  return true;
}

export const _gifState = { lastNotice };
