// Lockdown: members can't send messages, create threads or react anywhere until it's lifted.
// Before changing a channel, Sentinel saves its exact permissions, so /lockdown off puts them back as they were.
// Staff (staff + manager roles from Orbit's settings) are given permission to keep talking during it.
import { ChannelType, PermissionFlagsBits, Routes } from 'discord.js';
import { updateSettings, query } from '../db.js';
import { client } from '../bot/client.js';
import { alert, SENTINEL_GREEN } from './alerts.js';
import { settings } from './state.js';

const P = PermissionFlagsBits;
export const LOCK_BITS = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads | P.AddReactions;
export const STAFF_BITS = P.SendMessages | P.SendMessagesInThreads | P.AddReactions;
const TEXTY = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

const bits = (v) => BigInt(v?.bitfield ?? v ?? 0);

/** Works out every permission change a lockdown needs. Pure: reads the guild, changes nothing. */
export function planLockdown(guild, s) {
  const lockRoles = [guild.id, ...(s.sentinel_lockdown_role_ids || [])].filter((id, i, a) => a.indexOf(id) === i && guild.roles.cache.has(id));
  const staffRoles = [s.staff_role_id, s.manager_role_id].filter((id, i, a) => id && a.indexOf(id) === i && guild.roles.cache.has(id));
  const changes = [];
  let channelCount = 0;
  for (const ch of guild.channels.cache.values()) {
    if (!TEXTY.has(ch.type)) continue;
    let locked = false;
    for (const roleId of lockRoles) {
      const perms = ch.permissionsFor(roleId);
      if (!perms?.has?.(P.ViewChannel) || !perms.has(P.SendMessages)) continue; // they can't talk there anyway
      const ow = ch.permissionOverwrites.cache.get(roleId);
      const allow = bits(ow?.allow);
      const deny = bits(ow?.deny);
      changes.push({ channelId: ch.id, channelName: ch.name, targetId: roleId, kind: 'lock', existed: Boolean(ow), allow, deny, nextAllow: allow & ~LOCK_BITS, nextDeny: deny | LOCK_BITS });
      locked = true;
    }
    if (!locked) continue;
    channelCount += 1;
    for (const roleId of staffRoles) {
      const ow = ch.permissionOverwrites.cache.get(roleId);
      const allow = bits(ow?.allow);
      const deny = bits(ow?.deny);
      if ((allow & STAFF_BITS) === STAFF_BITS && !(deny & STAFF_BITS)) continue; // already allowed
      changes.push({ channelId: ch.id, channelName: ch.name, targetId: roleId, kind: 'staff', existed: Boolean(ow), allow, deny, nextAllow: allow | STAFF_BITS, nextDeny: deny & ~STAFF_BITS });
    }
  }
  return { changes, channelCount, lockRoles, staffRoles };
}

const putOverwrite = (rest, channelId, targetId, allow, deny, reason) => rest.put(Routes.channelPermission(channelId, targetId), {
  body: { type: 0, allow: allow.toString(), deny: deny.toString() }, reason,
});

/** Locks the server. by: the user who did it (or Sentinel for an automatic one). */
export async function lockdownOn({ guild, by = null, reason = '', rest = client.rest }) {
  const s = await settings({ force: true });
  if (s.sentinel_lockdown_active) return { already: true };
  const plan = planLockdown(guild, s);
  if (!plan.changes.length) return { nothing: true };
  // Save first (keeps the original if a channel was somehow saved already)
  for (const c of plan.changes) {
    await query(
      `INSERT INTO sentinel_lockdown_saved (channel_id, target_id, existed, allow_bits, deny_bits) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_id, target_id) DO NOTHING`,
      [c.channelId, c.targetId, c.existed, c.allow.toString(), c.deny.toString()],
    );
  }
  await updateSettings({ sentinel_lockdown_active: true });
  const why = `Lockdown by ${by?.tag || by?.username || 'Sentinel'}${reason ? `: ${reason}` : ''}`.slice(0, 400);
  let failed = 0;
  for (const c of plan.changes) {
    await putOverwrite(rest, c.channelId, c.targetId, c.nextAllow, c.nextDeny, why).catch((err) => { failed += 1; console.warn('[lockdown]', c.channelName, err.message); });
  }
  await settings({ force: true });
  await alert({
    kind: 'lockdown', guild, actor: by,
    title: '🔒 Server locked down',
    lines: [
      `${by ? `<@${by.id}>` : 'Sentinel (automatic)'} locked **${plan.channelCount} channel${plan.channelCount === 1 ? '' : 's'}**. Members can read but can't send messages, make threads or react.`,
      reason ? `**Reason:** ${reason}` : '',
      plan.staffRoles.length ? 'Staff can still talk.' : 'No staff role is set in Orbit, so only admins can talk.',
      failed ? `⚠️ ${failed} change(s) failed. Sentinel may be missing permissions in some channels.` : '',
      '\nLift it with `/lockdown off`.',
    ],
    detail: { channels: plan.channelCount, edits: plan.changes.length, failed, reason },
    pingOwner: !by || by.id !== guild.ownerId,
  });
  return { channels: plan.channelCount, edits: plan.changes.length, failed };
}

/** Puts every saved permission back exactly as it was. */
export async function lockdownOff({ guild, by = null, rest = client.rest }) {
  const { rows } = await query('SELECT * FROM sentinel_lockdown_saved');
  let failed = 0;
  const channels = new Set();
  for (const r of rows) {
    channels.add(r.channel_id);
    const reason = `Lockdown lifted by ${by?.tag || by?.username || 'Sentinel'}`;
    const exists = guild.channels.cache.has(r.channel_id);
    try {
      if (exists) {
        if (r.existed) await putOverwrite(rest, r.channel_id, r.target_id, BigInt(r.allow_bits), BigInt(r.deny_bits), reason);
        else await rest.delete(Routes.channelPermission(r.channel_id, r.target_id), { reason });
      }
      await query('DELETE FROM sentinel_lockdown_saved WHERE channel_id = $1 AND target_id = $2', [r.channel_id, r.target_id]);
    } catch (err) {
      failed += 1;
      console.warn('[unlock]', r.channel_id, err.message);
    }
  }
  if (!failed) await updateSettings({ sentinel_lockdown_active: false });
  await settings({ force: true });
  await alert({
    kind: 'unlock', guild, actor: by, color: SENTINEL_GREEN,
    title: failed ? '🔓 Lockdown partly lifted' : '🔓 Lockdown lifted',
    lines: [
      `${by ? `<@${by.id}>` : 'Sentinel'} restored **${channels.size} channel${channels.size === 1 ? '' : 's'}** to how they were.`,
      failed ? `⚠️ ${failed} change(s) failed. Run \`/lockdown off\` again to retry them.` : '',
    ],
    detail: { channels: channels.size, failed },
    pingOwner: false,
  });
  return { channels: channels.size, failed };
}
