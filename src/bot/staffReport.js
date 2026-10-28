// Weekly staff report: once a week Orbit posts what each staff member did in the last 7 days.
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { getSettings, query, updateSettings } from '../db.js';
import { tzParts } from '../schedule.js';
import { staffActivity } from '../stats.js';
import { client } from './client.js';
import { onlineMinutesSince, presenceTracking } from './presence.js';
import { isOnLoa, todayIn } from './staff.js';
import { COLORS, footer, truncate } from './ui.js';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Everyone with the staff or manager role, plus the server owner. */
export function staffMembers(guild, settings) {
  const map = new Map();
  for (const roleId of [settings.staff_role_id, settings.manager_role_id].filter(Boolean)) {
    const role = guild.roles.cache.get(roleId);
    for (const m of role?.members?.values() || []) {
      if (!m.user.bot) map.set(m.id, { id: m.id, name: m.displayName || m.user.username, tag: m.user.tag || m.user.username });
    }
  }
  const owner = guild.members.cache.get(guild.ownerId);
  if (owner && !owner.user.bot) map.set(owner.id, { id: owner.id, name: owner.displayName || owner.user.username, tag: owner.user.tag || owner.user.username, isOwner: true });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function modActionsSince(since) {
  const { rows } = await query(
    `SELECT mod_id AS id, count(*)::int AS n FROM mod_cases
      WHERE guild_id = $1 AND mod_id IS NOT NULL AND created_at >= $2 GROUP BY mod_id`,
    [config.guildId, since],
  );
  return new Map(rows.map((r) => [r.id, r.n]));
}

const hours = (min) => (min >= 60 ? `${Math.round(min / 6) / 10}h` : `${Math.round(min)}m`);
const shortDate = (d, tz) => d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });

/** Rows for the report: [{ id, name, apps, tickets, mod, online, total, loa }]. */
export async function reportRows(guild, settings, now = new Date()) {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const tz = settings.timezone || 'America/New_York';
  const [activity, mod, online] = await Promise.all([
    staffActivity(since), modActionsSince(since), onlineMinutesSince(todayIn(tz, since), now.getTime()),
  ]);
  return staffMembers(guild, settings).map((m) => {
    const a = activity.get(m.id) || {};
    const apps = (a.reviews || 0) + (a.votes || 0) + (a.interviews || 0);
    const tickets = (a.claimed || 0) + (a.closed || 0);
    const modN = mod.get(m.id) || 0;
    return { ...m, apps, tickets, mod: modN, online: online.get(m.id) || 0, total: apps + tickets + modN, loa: Boolean(isOnLoa(m.id)) };
  }).sort((x, y) => y.total - x.total || y.online - x.online || x.name.localeCompare(y.name));
}

export async function buildReport(guild, settings, now = new Date()) {
  const tz = settings.timezone || 'America/New_York';
  const rows = await reportRows(guild, settings, now);
  const showOnline = presenceTracking();
  const lines = rows.map((r) => {
    const time = showOnline ? ` · ⏱️ ${hours(r.online)}` : '';
    if (r.loa && r.total === 0) return `🌴 **${r.name}** — on leave${time}`;
    if (r.total === 0) return `⚠️ **${r.name}** — no applications, tickets or mod actions${time}`;
    return `✅ **${r.name}** — 📥 ${r.apps} · 🎫 ${r.tickets} · 🔨 ${r.mod}${time}`;
  });
  const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
  const inactive = rows.filter((r) => r.total === 0 && !r.loa).length;
  const start = new Date(now.getTime() - 7 * 86_400_000);
  return new EmbedBuilder().setColor(COLORS.brand)
    .setAuthor({ name: '📊 Weekly staff report' })
    .setTitle(`${shortDate(start, tz)} – ${shortDate(now, tz)}`)
    .setDescription(truncate([
      `**${rows.length - inactive}** of ${rows.length} staff were active · **${inactive}** inactive (not on leave)`,
      '',
      ...lines,
      '',
      `-# 📥 applications reviewed, voted or interviewed · 🎫 tickets claimed or closed · 🔨 mod actions${showOnline ? ' · ⏱️ time online' : ''}`,
    ].join('\n'), 4096))
    .addFields(
      { name: '📥 Applications', value: String(sum('apps')), inline: true },
      { name: '🎫 Tickets', value: String(sum('tickets')), inline: true },
      { name: '🔨 Mod actions', value: String(sum('mod')), inline: true },
    )
    .setFooter(footer('Weekly staff report', client));
}

/** Posts the report now. Returns { ok, error }. */
export async function postReport(now = new Date()) {
  const settings = await getSettings();
  if (!settings.staff_report_channel_id) return { ok: false, error: 'Pick a channel for the report first.' };
  const guild = client.guilds.cache.get(config.guildId);
  const channel = guild?.channels.cache.get(settings.staff_report_channel_id);
  if (!channel?.isTextBased?.()) return { ok: false, error: "Orbit can't find the report channel." };
  const embed = await buildReport(guild, settings, now);
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return { ok: true };
}

/** Posts the weekly report once, on the chosen day after the chosen hour (server time zone). */
export async function reportTick(now = new Date()) {
  const s = await getSettings();
  if (!s.staff_report_channel_id) return false;
  const tz = s.timezone || 'America/New_York';
  const p = tzParts(now, tz);
  const today = todayIn(tz, now);
  if (p.weekday !== s.staff_report_day || p.hh < s.staff_report_hour || s.staff_report_last === today) return false;
  await updateSettings({ staff_report_last: today });
  const r = await postReport(now);
  if (!r.ok) console.warn('[staff report]', r.error);
  return r.ok;
}

export function startStaffReport() {
  return setInterval(() => reportTick().catch((e) => console.warn('[staff report] failed:', e.message)), 10 * 60 * 1000);
}
