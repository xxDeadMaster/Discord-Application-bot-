// Raid alarm: too many people joining too fast (default 8 in 60 seconds) means a raid.
// Sentinel alerts the owner, and locks the server if auto-lockdown is on.
import { alert } from './alerts.js';
import { lockdownOn } from './lockdown.js';
import { settings } from './state.js';

const QUIET_MS = 10 * 60 * 1000; // a raid ends after 10 minutes without another burst
const NEW_ACCOUNT_DAYS = 7;

let joins = []; // { at, id, tag, created }
let raidUntil = 0;

/** Records a join. Returns { count, startsRaid, inRaid, recent }. */
export function recordJoin(member, { joinsLimit, seconds }, now = Date.now()) {
  const windowMs = seconds * 1000;
  joins = joins.filter((j) => now - j.at < windowMs);
  joins.push({ at: now, id: member.id, tag: member.user?.tag || member.user?.username || member.id, created: member.user?.createdTimestamp || 0 });
  const tripped = joins.length >= joinsLimit;
  const inRaid = now < raidUntil;
  if (tripped) raidUntil = now + QUIET_MS;
  return { count: joins.length, startsRaid: tripped && !inRaid, inRaid: tripped || inRaid, recent: [...joins] };
}

export async function handleJoin(member, now = Date.now()) {
  const s = await settings();
  if (s.sentinel_raid_enabled === false) return { off: true };
  const r = recordJoin(member, { joinsLimit: s.sentinel_raid_joins || 8, seconds: s.sentinel_raid_seconds || 60 }, now);
  if (!r.startsRaid) return r;
  const fresh = r.recent.filter((j) => j.created && now - j.created < NEW_ACCOUNT_DAYS * 86400000).length;
  let lock = null;
  if (s.sentinel_auto_lockdown && !s.sentinel_lockdown_active) {
    lock = await lockdownOn({ guild: member.guild, reason: `Raid: ${r.count} joins in ${s.sentinel_raid_seconds}s` }).catch((err) => ({ error: err.message }));
  }
  await alert({
    kind: 'raid', guild: member.guild,
    title: '🚨 Possible raid',
    lines: [
      `**${r.count} people joined in ${s.sentinel_raid_seconds} seconds.** ${fresh} of them have accounts less than ${NEW_ACCOUNT_DAYS} days old.`,
      `**Latest:** ${r.recent.slice(-10).map((j) => `<@${j.id}>`).join(' ')}`,
      lock?.channels ? `🔒 Auto-lockdown is on, so Sentinel locked **${lock.channels} channels**. Lift it with \`/lockdown off\`.` : '',
      lock?.error ? `⚠️ Auto-lockdown failed: ${lock.error}` : '',
      !s.sentinel_auto_lockdown ? 'To lock the server now, use `/lockdown on`.' : '',
    ],
    detail: { joins: r.count, seconds: s.sentinel_raid_seconds, newAccounts: fresh, ids: r.recent.map((j) => j.id), locked: Boolean(lock?.channels) },
  });
  return { ...r, alerted: true, lock };
}

export const _raidState = { reset() { joins = []; raidUntil = 0; } };
