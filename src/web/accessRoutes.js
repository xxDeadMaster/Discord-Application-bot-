// Staff access (owner only): pick exactly which staff can use Orbit and Sentinel.
// An empty list means "no restriction" (the staff/manager roles decide, as before).
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { getSettings, updateSettings } from '../db.js';
import { staffMembers } from '../bot/staffReport.js';
import { sentinelLocal } from './sentinelRoutes.js';

export const accessRoutes = express.Router();

function ownerOnly(req, res, next) {
  if (res.locals.isOwner) return next();
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.', user: res.locals.user });
}

/** Everyone who could be picked: staff + manager roles, admins, and anyone already on a list. */
export function accessCandidates(guild, settings) {
  const rows = new Map(staffMembers(guild, settings).map((m) => [m.id, { ...m }]));
  for (const m of guild.members.cache.values()) {
    if (m.user.bot || rows.has(m.id)) continue;
    if (m.permissions?.has(PermissionFlagsBits.ManageGuild) || m.permissions?.has(PermissionFlagsBits.Administrator)) {
      rows.set(m.id, { id: m.id, name: m.displayName || m.user.username, tag: m.user.tag || m.user.username });
    }
  }
  for (const id of [...(settings.orbit_access_ids || []), ...(settings.sentinel_access_ids || [])]) {
    if (!rows.has(id)) {
      const m = guild.members.cache.get(id);
      rows.set(id, { id, name: m ? (m.displayName || m.user.username) : `Left the server (${id})`, tag: m?.user?.tag || id, gone: !m });
    }
  }
  const managerRole = settings.manager_role_id;
  const staffRole = settings.staff_role_id;
  return [...rows.values()].map((r) => {
    const m = guild.members.cache.get(r.id);
    const role = r.id === guild.ownerId ? 'Owner'
      : m?.permissions?.has(PermissionFlagsBits.Administrator) ? 'Administrator'
        : m?.permissions?.has(PermissionFlagsBits.ManageGuild) ? 'Manage Server'
          : managerRole && m?.roles?.cache?.has(managerRole) ? 'Manager'
            : staffRole && m?.roles?.cache?.has(staffRole) ? 'Staff' : (r.gone ? 'Not in server' : 'No staff role');
    return { ...r, isOwner: r.id === guild.ownerId, role, avatar: m?.displayAvatarURL?.({ size: 64 }) || null };
  }).sort((a, b) => (b.isOwner - a.isOwner) || a.name.localeCompare(b.name));
}

accessRoutes.get('/access', ownerOnly, async (req, res) => {
  const settings = await getSettings();
  res.render('access', {
    title: 'Staff access',
    people: accessCandidates(res.locals.guild, settings),
    orbit: settings.orbit_access_ids || [],
    sentinel: settings.sentinel_access_ids || [],
  });
});

const ids = (v) => [...new Set((v === undefined ? [] : Array.isArray(v) ? v : [v]).map(String).filter((x) => /^\d{1,20}$/.test(x)))];

accessRoutes.post('/access', ownerOnly, async (req, res) => {
  const settings = await getSettings();
  const guild = res.locals.guild;
  const allowed = new Set(accessCandidates(guild, settings).map((p) => p.id));
  allowed.delete(guild.ownerId); // the owner always has access; never stored
  const orbit = ids(req.body.orbit).filter((id) => allowed.has(id));
  const sentinel = ids(req.body.sentinel).filter((id) => allowed.has(id));
  await updateSettings({ orbit_access_ids: orbit, sentinel_access_ids: sentinel });
  await sentinelLocal('/reload', {}); // Sentinel picks it up right away (or within 2 minutes if it's offline now)
  const part = (n, bot) => (n ? `${bot}: you + ${n} picked` : `${bot}: open to all staff`);
  req.session.flash = { type: 'success', text: `Saved. ${part(orbit.length, 'Orbit')} · ${part(sentinel.length, 'Sentinel')}.` };
  res.redirect('/access');
});
