// Sentinel's alerts: saved as events (for the dashboard), posted in the Sentinel log channel,
// and DMed to the server owner for anything serious.
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { client } from '../bot/client.js';
import { settings } from './state.js';

export const SENTINEL_RED = 0xd7263d;
export const SENTINEL_GREEN = 0x2fb27a;
export const SENTINEL_AMBER = 0xffb020;

export function sentinelFooter() {
  const icon = client.user?.displayAvatarURL?.({ size: 64 });
  return icon ? { text: 'Sentinel · BloxVerse security', iconURL: icon } : { text: 'Sentinel · BloxVerse security' };
}

export async function recordEvent({ kind, actor = null, summary = '', detail = {} }) {
  const { rows } = await query(
    `INSERT INTO sentinel_events (guild_id, kind, actor_id, actor_tag, summary, detail)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [config.guildId, kind, actor?.id || null, actor?.tag || actor?.username || null, summary.slice(0, 500), detail],
  );
  return rows[0];
}

export async function recentEvents(limit = 20) {
  const { rows } = await query('SELECT * FROM sentinel_events WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2', [config.guildId, limit]);
  return rows;
}

/**
 * Records + posts an alert. lines: array of strings for the description.
 * pingOwner: mention the owner in the log channel and DM them.
 */
export async function alert({ kind, title, lines = [], actor = null, detail = {}, color = SENTINEL_RED, pingOwner = true, guild = null }) {
  const event = await recordEvent({ kind, actor, summary: title, detail }).catch((err) => { console.warn('[sentinel] could not save event:', err.message); return null; });
  const s = await settings();
  const g = guild || client.guilds.cache.get(config.guildId);
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(lines.join('\n').slice(0, 4000) || null)
    .setFooter(sentinelFooter()).setTimestamp(new Date());
  const ownerId = g?.ownerId;
  let posted = false;
  let dmed = false;
  if (s.sentinel_log_channel_id) {
    const ch = await client.channels.fetch(s.sentinel_log_channel_id).catch(() => null);
    if (ch?.send) {
      posted = Boolean(await ch.send({
        content: pingOwner && ownerId ? `<@${ownerId}>` : undefined,
        embeds: [embed],
        allowedMentions: { users: pingOwner && ownerId ? [ownerId] : [] },
      }).catch((err) => console.warn('[sentinel] could not post alert:', err.message)));
    }
  }
  if (pingOwner && ownerId) {
    const owner = await client.users.fetch(ownerId).catch(() => null);
    dmed = Boolean(await owner?.send({ embeds: [embed] }).catch(() => null));
  }
  console.log(`[sentinel] ${kind}: ${title}`);
  return { event, posted, dmed };
}
