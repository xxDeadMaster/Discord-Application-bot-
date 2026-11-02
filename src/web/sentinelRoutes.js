// Sentinel's side of the dashboard: owner only. Live data comes from Sentinel itself over a local-only
// connection (both bots run on the same phone); history comes from the database.
import express from 'express';
import { config } from '../config.js';
import { getOrCreateSecret, getSettings, query, updateSettings } from '../db.js';
import { loadGifBlock } from '../bot/gifBlock.js';
import { loadTrap } from '../bot/spamTrap.js';
import { staffStatus } from '../bot/presence.js';
import { staffMembers } from '../bot/staffReport.js';

export const sentinelRoutes = express.Router();

const LOCAL_URL = `http://127.0.0.1:${Number(process.env.SENTINEL_LOCAL_PORT) || 3101}`;
let fetchFn = (...a) => fetch(...a);
export const _setSentinelFetch = (fn) => { fetchFn = fn; };

/** Calls Sentinel on the phone. Returns null when Sentinel isn't reachable. */
export async function sentinelLocal(path, body = null) {
  try {
    const key = await getOrCreateSecret('sentinel_local');
    const res = await fetchFn(`${LOCAL_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-sentinel-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body ? 120_000 : 3_000), // a lockdown can take a while on a big server
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Only the server owner can see Sentinel. Everyone else gets a plain "not found". */
function requireOwner(req, res, next) {
  if (res.locals.isOwner) return next();
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.', user: res.locals.user });
}
sentinelRoutes.use('/sentinel', requireOwner);

const KINDS = ['joins', 'leaves', 'blocked', 'mod'];
const HOUR = 3600000;

/** Chart points for 24h (24 hourly points) or 7d (42 four-hour points), from saved hours + the hour in progress. */
export async function historySeries(range, hourNow, now = Date.now()) {
  const step = range === '7d' ? 4 * HOUR : HOUR;
  const n = range === '7d' ? 42 : 24;
  const end = now - (now % HOUR) + HOUR; // end of the current hour
  const start = end - n * step;
  const { rows } = await query('SELECT * FROM sentinel_activity WHERE guild_id = $1 AND hour >= $2 ORDER BY hour', [config.guildId, new Date(start)]);
  const series = Object.fromEntries(KINDS.map((k) => [k, Array(n).fill(0)]));
  const add = (t, r) => {
    const i = Math.floor((t - start) / step);
    if (i >= 0 && i < n) for (const k of KINDS) series[k][i] += Number(r[k]) || 0;
  };
  for (const r of rows) add(new Date(r.hour).getTime(), r);
  if (hourNow) add(hourNow.t, hourNow);
  return series;
}

const ago = (d) => (d ? Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000)) : null);

/** Everything the overview needs, refreshed every few seconds by the page. */
async function liveData(req, res) {
  const range = ['1h', '24h', '7d'].includes(req.query.range) ? req.query.range : '1h';
  const guild = res.locals.guild;
  const [s, live] = await Promise.all([getSettings(), sentinelLocal('/live')]);
  const chart = range === '1h' ? (live?.minute || Object.fromEntries(KINDS.map((k) => [k, Array(60).fill(0)]))) : await historySeries(range, live?.hourNow);

  const since24 = new Date(Date.now() - 24 * HOUR);
  const [{ rows: events }, { rows: [blocked24] }, { rows: attention }] = await Promise.all([
    query('SELECT id, kind, actor_id, actor_tag, summary, detail, created_at FROM sentinel_events WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 1', [config.guildId]),
    query('SELECT COALESCE(sum(blocked), 0)::int AS n FROM sentinel_activity WHERE guild_id = $1 AND hour >= $2', [config.guildId, since24]),
    query(`SELECT id, actor_id, actor_tag, summary, detail, created_at FROM sentinel_events
           WHERE guild_id = $1 AND kind = 'nuke' AND detail->>'resolved' = 'false' AND created_at > now() - interval '7 days'
           ORDER BY created_at DESC LIMIT 5`, [config.guildId]),
  ]);
  const { rows: raids } = await query("SELECT summary, detail, created_at FROM sentinel_events WHERE guild_id = $1 AND kind = 'raid' AND created_at > now() - interval '10 minutes' ORDER BY created_at DESC LIMIT 1", [config.guildId]);
  const { rows: lockRows } = await query("SELECT actor_tag, created_at FROM sentinel_events WHERE guild_id = $1 AND kind = 'lockdown' ORDER BY created_at DESC LIMIT 1", [config.guildId]);
  const { rows: [lockCount] } = await query('SELECT count(DISTINCT channel_id)::int AS n FROM sentinel_lockdown_saved');

  const status = s.sentinel_lockdown_active ? 'lock' : raids.length ? 'raid' : 'clear';
  const hourBlocked = live?.hourNow?.blocked || 0;
  const staff = staffMembers(guild, s).map((m) => {
    const member = guild.members.cache.get(m.id);
    const st = staffStatus(member);
    const top = member?.roles?.highest;
    return { name: m.name, owner: Boolean(m.isOwner), status: st.status, role: m.isOwner ? 'Owner' : (top && top.id !== guild.id ? top.name : 'Staff') };
  }).sort((a, b) => (a.status === 'offline') - (b.status === 'offline') || b.owner - a.owner);
  const ch = (id) => (id ? guild.channels.cache.get(id)?.name : null);

  res.json({
    range,
    status,
    sentinel: live ? { online: live.online, ping: live.ping, uptimeMin: live.uptimeMin, memory: live.memory, phone: live.phone } : null,
    joins10: live?.joins10 ?? null,
    blocked24: (blocked24?.n || 0) + hourBlocked,
    raid: raids[0] ? { summary: raids[0].summary, joins: raids[0].detail?.joins, newAccounts: raids[0].detail?.newAccounts, minAgo: ago(raids[0].created_at) } : null,
    lockdown: s.sentinel_lockdown_active ? { channels: lockCount?.n || 0, by: lockRows[0]?.actor_tag || 'Sentinel', since: lockRows[0]?.created_at || null } : null,
    lastIncident: events[0] ? { summary: events[0].summary.replace(/^[^\p{L}\p{N}]+/u, ''), minAgo: ago(events[0].created_at) } : null,
    attention: attention.map((a) => ({ id: a.id, who: a.actor_tag || a.actor_id, summary: a.summary, label: a.detail?.label, count: a.detail?.count, roles: (a.detail?.removedRoleIds || []).length, kicked: Boolean(a.detail?.kicked), minAgo: ago(a.created_at) })),
    chart,
    feed: live?.feed || [],
    staff,
    modules: {
      antinuke: { on: s.sentinel_antinuke_enabled, trusted: (s.sentinel_trusted_ids || []).length },
      raid: { on: s.sentinel_raid_enabled !== false, joins: s.sentinel_raid_joins, seconds: s.sentinel_raid_seconds, auto: s.sentinel_auto_lockdown },
      trap: { on: Boolean(s.trap_channel_id), channel: ch(s.trap_channel_id), bot: s.protection_bot || 'orbit' },
      gif: { on: Boolean(s.gif_block_enabled), allowed: (s.gif_allowed_channel_ids || []).map(ch).filter(Boolean), bot: s.protection_bot || 'orbit' },
    },
  });
}

sentinelRoutes.get('/sentinel', async (req, res) => {
  const s = await getSettings();
  res.render('sentinel/overview', { title: 'Security overview', active: 'overview', raidJoins: s.sentinel_raid_joins, raidSeconds: s.sentinel_raid_seconds });
});

sentinelRoutes.get('/sentinel/live.json', (req, res, next) => liveData(req, res).catch(next));

const json = (res, code, body) => res.status(code).json(body);
const who = (res) => ({ byId: res.locals.user.id, byName: res.locals.member?.displayName || res.locals.user.name || 'the owner' });

sentinelRoutes.post('/sentinel/lockdown', async (req, res) => {
  const on = req.body.on === '1';
  if (on && String(req.body.confirm || '').trim().toUpperCase() !== 'LOCKDOWN') return json(res, 400, { error: 'Type LOCKDOWN to confirm.' });
  const r = await sentinelLocal('/lockdown', { on, reason: String(req.body.reason || '').slice(0, 200), ...who(res) });
  if (!r) return json(res, 503, { error: 'Sentinel is not reachable right now. Use /lockdown in Discord.' });
  if (r.already) return json(res, 409, { error: 'The server is already locked.' });
  if (r.nothing) return json(res, 409, { error: 'Nothing to lock: members already can\'t send messages anywhere.' });
  return json(res, 200, { ok: true, channels: r.channels, failed: r.failed });
});

sentinelRoutes.post('/sentinel/modules', async (req, res) => {
  const mod = String(req.body.module || '');
  const on = req.body.on === '1';
  if (mod === 'antinuke') {
    if (!on && String(req.body.confirm || '').trim().toUpperCase() !== 'OFF') return json(res, 400, { error: 'Type OFF to confirm.' });
    await updateSettings({ sentinel_antinuke_enabled: on });
  } else if (mod === 'raid') {
    await updateSettings({ sentinel_raid_enabled: on });
  } else if (mod === 'gif') {
    await updateSettings({ gif_block_enabled: on });
    await loadGifBlock();
  } else {
    return json(res, 400, { error: 'Unknown module.' });
  }
  await loadTrap();
  await sentinelLocal('/reload', {}); // Sentinel picks it up right away (or within 2 minutes if it's offline now)
  return json(res, 200, { ok: true });
});

sentinelRoutes.post('/sentinel/attention/:id/:action', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const action = req.params.action;
  if (!Number.isSafeInteger(id)) return json(res, 400, { error: 'Bad alert.' });
  if (action === 'keep') {
    await query("UPDATE sentinel_events SET detail = detail || $2 WHERE id = $1 AND guild_id = $3", [id, { resolved: 'kept', resolvedBy: who(res).byName }, config.guildId]);
    return json(res, 200, { ok: true });
  }
  if (action === 'restore' || action === 'ban') {
    if (action === 'ban' && String(req.body.confirm || '').trim().toUpperCase() !== 'BAN') return json(res, 400, { error: 'Type BAN to confirm.' });
    const r = await sentinelLocal(`/${action}`, { eventId: id, ...who(res) });
    if (!r) return json(res, 503, { error: 'Sentinel is not reachable right now.' });
    if (!r.ok) return json(res, 409, { error: r.error || 'That did not work.' });
    return json(res, 200, r);
  }
  return json(res, 400, { error: 'Unknown action.' });
});

const LOG_PAGE = 30;
sentinelRoutes.get('/sentinel/log', async (req, res) => {
  const kinds = ['nuke', 'alert', 'raid', 'lockdown', 'unlock'];
  const kind = kinds.includes(req.query.kind) ? req.query.kind : null;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const { rows } = await query(
    `SELECT * FROM sentinel_events WHERE guild_id = $1 ${kind ? 'AND kind = $4' : ''} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [config.guildId, LOG_PAGE + 1, (page - 1) * LOG_PAGE, ...(kind ? [kind] : [])],
  );
  res.render('sentinel/log', { title: 'Security log', active: 'log', events: rows.slice(0, LOG_PAGE), hasMore: rows.length > LOG_PAGE, page, kind });
});
