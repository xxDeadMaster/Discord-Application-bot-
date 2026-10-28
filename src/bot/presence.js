import { config } from '../config.js';
import { getSettings, query } from '../db.js';
import { client } from './client.js';
import { todayIn } from './staff.js';

/**
 * Online / offline status for staff, shown on the Staff activity page and in the weekly report.
 * Needs the Presence Intent (Developer Portal → Bot). Without it Orbit runs as before
 * and the page shows a note instead of statuses.
 * Only staff (and the server owner) are tracked. Online time is kept in memory and saved about once an hour.
 */

let tracking = false;
let staffRoleIds = [];
let timezone = 'America/New_York';
const lastSeen = new Map(); // userId -> Date they were last online
const sessions = new Map(); // userId -> ms they came online (still online)
const unsaved = new Map(); // `${userId}|${day}` -> minutes not saved yet

export const presenceTracking = () => tracking;
export function setPresenceTracking(on) { tracking = Boolean(on); }

const isOnline = (status) => Boolean(status) && status !== 'offline' && status !== 'invisible';

function isTrackedStaff(member) {
  if (!member || member.user?.bot) return false;
  if (member.guild?.ownerId && member.id === member.guild.ownerId) return true;
  return staffRoleIds.some((id) => member.roles?.cache?.has(id));
}

/** Loads the staff roles and saved "last seen" times, and starts timing staff who are online right now. */
export async function loadPresence() {
  const s = await getSettings();
  staffRoleIds = [s.staff_role_id, s.manager_role_id].filter(Boolean);
  timezone = s.timezone || timezone;
  const { rows } = await query('SELECT user_id, last_online FROM staff_presence WHERE guild_id = $1', [config.guildId]);
  lastSeen.clear();
  for (const r of rows) lastSeen.set(r.user_id, new Date(r.last_online));
  if (!tracking) return;
  const guild = client.guilds?.cache?.get(config.guildId);
  for (const m of guild?.members?.cache?.values() || []) {
    if (isTrackedStaff(m) && isOnline(m.presence?.status) && !sessions.has(m.id)) sessions.set(m.id, Date.now());
  }
}

function addTime(userId, ms, at) {
  if (ms < 30_000) return;
  const key = `${userId}|${todayIn(timezone, new Date(at))}`;
  unsaved.set(key, (unsaved.get(key) || 0) + ms / 60_000);
}

/** Discord presence update: time online sessions and remember when a staff member goes offline. */
export async function handlePresenceUpdate(oldPresence, newPresence, now = Date.now()) {
  if (newPresence?.guild?.id !== config.guildId) return;
  if (!isTrackedStaff(newPresence.member)) return;
  const id = newPresence.userId;
  const was = oldPresence ? isOnline(oldPresence.status) : sessions.has(id);
  const on = isOnline(newPresence.status);
  if (on && !sessions.has(id)) sessions.set(id, now);
  if (was && !on) {
    const start = sessions.get(id);
    sessions.delete(id);
    if (start) addTime(id, now - start, now);
    const at = new Date(now);
    lastSeen.set(id, at);
    await query(
      `INSERT INTO staff_presence (guild_id, user_id, last_online) VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET last_online = EXCLUDED.last_online`,
      [config.guildId, id, at],
    );
  }
}

/** Saves online time (including sessions still running). Returns how many rows were written. */
export async function flushPresence(now = Date.now()) {
  for (const [id, start] of sessions) { addTime(id, now - start, now); sessions.set(id, now); }
  const rows = [...unsaved.entries()].map(([k, min]) => { const [userId, day] = k.split('|'); return { userId, day, min: Math.round(min) }; }).filter((r) => r.min > 0);
  unsaved.clear();
  for (const r of rows) {
    await query(
      `INSERT INTO staff_online_time (guild_id, user_id, day, minutes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, user_id, day) DO UPDATE SET minutes = staff_online_time.minutes + EXCLUDED.minutes`,
      [config.guildId, r.userId, r.day, r.min],
    );
  }
  return rows.length;
}

export function startPresenceSaver() {
  return setInterval(() => flushPresence().catch((e) => console.warn('[presence] save failed:', e.message)), 60 * 60 * 1000);
}

/** Minutes online per user since a day (YYYY-MM-DD), including time not saved yet. */
export async function onlineMinutesSince(day, now = Date.now()) {
  const { rows } = await query('SELECT user_id, sum(minutes)::int AS m FROM staff_online_time WHERE guild_id = $1 AND day >= $2 GROUP BY user_id', [config.guildId, day]);
  const out = new Map(rows.map((r) => [r.user_id, r.m]));
  for (const [k, min] of unsaved) { const [id, d] = k.split('|'); if (d >= day) out.set(id, (out.get(id) || 0) + min); }
  for (const [id, start] of sessions) out.set(id, (out.get(id) || 0) + (now - start) / 60_000);
  return out;
}

const LABELS = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline' };

/** { status, label, lastSeen } for one member, for the dashboard. */
export function staffStatus(member) {
  const raw = member?.presence?.status;
  const status = isOnline(raw) ? raw : 'offline';
  return { status, label: LABELS[status] || LABELS.offline, lastSeen: status === 'offline' ? (lastSeen.get(member?.id) || null) : null };
}

export const _presenceState = { lastSeen, sessions, unsaved, setStaffRoles: (ids) => { staffRoleIds = ids; } };
