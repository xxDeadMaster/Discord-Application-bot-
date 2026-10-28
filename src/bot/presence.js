import { config } from '../config.js';
import { getSettings, query } from '../db.js';

/**
 * Online / offline status for staff, shown on the Staff activity page.
 * Needs the Presence Intent (Developer Portal → Bot). Without it Orbit runs as before
 * and the page shows a note instead of statuses.
 * Only staff are tracked: one small database write when a staff member goes offline.
 */

let tracking = false;
let staffRoleIds = [];
const lastSeen = new Map(); // userId -> Date they were last online

export const presenceTracking = () => tracking;
export function setPresenceTracking(on) { tracking = Boolean(on); }

/** Loads the staff roles and saved "last seen" times. Call at startup and after Settings are saved. */
export async function loadPresence() {
  const s = await getSettings();
  staffRoleIds = [s.staff_role_id, s.manager_role_id].filter(Boolean);
  const { rows } = await query('SELECT user_id, last_online FROM staff_presence WHERE guild_id = $1', [config.guildId]);
  lastSeen.clear();
  for (const r of rows) lastSeen.set(r.user_id, new Date(r.last_online));
}

const isStaff = (member) => Boolean(member && !member.user?.bot && staffRoleIds.some((id) => member.roles.cache.has(id)));
const isOnline = (status) => Boolean(status) && status !== 'offline' && status !== 'invisible';

/** Discord presence update: remember when a staff member goes offline. */
export async function handlePresenceUpdate(oldPresence, newPresence) {
  if (newPresence?.guild?.id !== config.guildId) return;
  if (!isStaff(newPresence.member)) return;
  const was = isOnline(oldPresence?.status);
  const now = isOnline(newPresence.status);
  // oldPresence is missing when the bot hasn't seen them yet; treat that as "was online" only if they're offline now
  if ((was || !oldPresence) && !now) {
    const at = new Date();
    lastSeen.set(newPresence.userId, at);
    await query(
      `INSERT INTO staff_presence (guild_id, user_id, last_online) VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET last_online = EXCLUDED.last_online`,
      [config.guildId, newPresence.userId, at],
    );
  }
}

const LABELS = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline' };

/** { status, label, lastSeen } for one member, for the dashboard. */
export function staffStatus(member) {
  const raw = member?.presence?.status;
  const status = isOnline(raw) ? raw : 'offline';
  return { status, label: LABELS[status] || LABELS.offline, lastSeen: status === 'offline' ? (lastSeen.get(member?.id) || null) : null };
}

export const _presenceState = { lastSeen, setStaffRoles: (ids) => { staffRoleIds = ids; } };
