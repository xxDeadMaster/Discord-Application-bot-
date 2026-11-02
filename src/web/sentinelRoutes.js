// Sentinel's side of the dashboard: owner only. Live data comes from Sentinel itself over a local-only
// connection (both bots run on the same phone); history comes from the database.
import express from 'express';
import { config } from '../config.js';
import { getOrCreateSecret, getSettings, query, updateSettings } from '../db.js';
import { loadGifBlock } from '../bot/gifBlock.js';
import { DEFAULT_TRAP_NAMES, cleanTrapNames, loadTrap, publishTrap, renameTrap } from '../bot/spamTrap.js';
import { guildOptions } from './routes.js';
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

/** Divider roles are names made mostly of lines/symbols, e.g. "──── MODERATION TEAM ────". */
export const isDivider = (name) => /[─━═⎯╭╮╰╯┃│]{2,}|[─━═⎯]{2,}|-{3,}|_{3,}/.test(name) || !/[\p{L}\p{N}]/u.test(name);

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
    // Highest real role: skip @everyone and divider roles like "──── STAFF ────"
    const real = [...(member?.roles?.cache?.values() || [])]
      .filter((r) => r.id !== guild.id && !isDivider(r.name))
      .sort((a, b) => b.position - a.position)[0];
    return { name: m.name, owner: Boolean(m.isOwner), status: st.status, role: m.isOwner ? 'Owner' : (real ? real.name : 'Staff') };
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

/* ---------- Spam trap & GIF blocker (moved here from Orbit's Moderation page) ---------- */

const flash = (req, type, text) => { req.session.flash = { type, text }; };

sentinelRoutes.get('/sentinel/filters', async (req, res) => {
  const s = await getSettings();
  res.render('sentinel/filters', {
    title: 'Spam trap & GIFs', active: 'filters',
    channels: guildOptions(res.locals.guild).textChannels,
    trap: { channelId: s.trap_channel_id, posted: Boolean(s.trap_message_id), caught: s.trap_caught || 0 },
    rename: { on: s.trap_rename_enabled, time: s.trap_rename_time || '04:00', last: s.trap_rename_last, names: s.trap_rename_names || [], tz: s.timezone || 'America/New_York' },
    defaultTrapNames: DEFAULT_TRAP_NAMES,
    gif: { enabled: s.gif_block_enabled, allowed: s.gif_allowed_channel_ids || [] },
    runner: s.protection_bot === 'orbit' ? 'orbit' : 'sentinel',
  });
});

/** Posts (or refreshes) the trap warning from whichever bot runs the trap. */
async function postTrapWarning(runner) {
  if (runner === 'sentinel') {
    const r = await sentinelLocal('/publishTrap', {});
    if (!r) throw new Error('Sentinel is not reachable right now, so the warning was not posted. Try again when it is online.');
    if (!r.ok) throw new Error(r.error || 'Sentinel could not post the warning.');
    return r;
  }
  return publishTrap();
}

sentinelRoutes.post('/sentinel/filters/trap', async (req, res) => {
  const id = String(req.body.trap_channel_id || '').trim();
  const channels = guildOptions(res.locals.guild).textChannels;
  if (id && !channels.some((c) => c.id === id)) { flash(req, 'error', 'Pick a channel from the list.'); return res.redirect('/sentinel/filters'); }
  const s = await getSettings();
  const moved = (id || null) !== (s.trap_channel_id || null);
  await updateSettings({ trap_channel_id: id || null, ...(moved ? { trap_message_id: null } : {}) });
  await loadTrap();
  await sentinelLocal('/reload', {});
  if (!id) { flash(req, 'success', 'Spam trap turned off.'); return res.redirect('/sentinel/filters'); }
  try {
    const r = await postTrapWarning(s.protection_bot === 'orbit' ? 'orbit' : 'sentinel');
    flash(req, 'success', `Spam trap is on. ${r.updated ? 'The warning message was updated.' : 'The warning message was posted.'} Anyone who isn't staff and posts there is removed.`);
  } catch (err) {
    flash(req, 'error', `Saved, but ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}`);
  }
  res.redirect('/sentinel/filters');
});

sentinelRoutes.post('/sentinel/filters/gifs', async (req, res) => {
  const channels = guildOptions(res.locals.guild).textChannels;
  const raw = req.body.gif_allowed_channel_ids;
  const ids = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).filter((x) => channels.some((c) => c.id === x));
  const enabled = req.body.gif_block_enabled === 'on';
  await updateSettings({ gif_block_enabled: enabled, gif_allowed_channel_ids: [...new Set(ids)] });
  await loadGifBlock();
  await sentinelLocal('/reload', {});
  flash(req, 'success', enabled ? `GIF blocker is on.${ids.length ? ` GIFs are still allowed in ${ids.length} channel${ids.length === 1 ? '' : 's'}.` : ''}` : 'GIF blocker is off.');
  res.redirect('/sentinel/filters#gifs');
});

/** Fallback switch: which bot runs the trap + GIF blocker (Sentinel normally; Orbit if Sentinel is down for a while). */
sentinelRoutes.post('/sentinel/filters/runner', async (req, res) => {
  const runner = req.body.protection_bot === 'orbit' ? 'orbit' : 'sentinel';
  await updateSettings({ protection_bot: runner });
  await Promise.all([loadTrap(), loadGifBlock()]);
  await sentinelLocal('/reload', {});
  let note = '';
  if ((await getSettings()).trap_channel_id) {
    try { await postTrapWarning(runner); } catch (err) { note = ` (${err.message})`; }
  }
  flash(req, note ? 'error' : 'success', runner === 'sentinel'
    ? `Sentinel now runs the spam trap and GIF blocker. Orbit has stopped running them.${note}`
    : `Orbit now runs the spam trap and GIF blocker (fallback).${note}`);
  res.redirect('/sentinel/filters#runner');
});

/** Daily rename settings: on/off, time (HH:MM, server timezone), optional own list of names. */
sentinelRoutes.post('/sentinel/filters/rename', async (req, res) => {
  const time = String(req.body.trap_rename_time || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { flash(req, 'error', 'Pick a time like 04:00.'); return res.redirect('/sentinel/filters#rename'); }
  const on = req.body.trap_rename_enabled === 'on';
  const names = cleanTrapNames(req.body.trap_rename_names);
  if (names.length === 1) { flash(req, 'error', 'Add at least 2 names (or leave it empty to use the built-in list), so the name can change every day.'); return res.redirect('/sentinel/filters#rename'); }
  const s = await getSettings();
  // Changing the time shouldn't count as "already renamed today" for a later time today
  await updateSettings({ trap_rename_enabled: on, trap_rename_time: time, trap_rename_names: names, ...(time !== s.trap_rename_time ? { trap_rename_last: null } : {}) });
  await loadTrap();
  await sentinelLocal('/reload', {});
  flash(req, 'success', on
    ? `The spam trap will get a new name every day at ${time}${names.length ? `, picked from your ${names.length} names` : ''}.${s.trap_channel_id ? '' : ' Pick a trap channel too.'}`
    : 'Daily rename is off. The trap keeps its current name.');
  res.redirect('/sentinel/filters#rename');
});

sentinelRoutes.post('/sentinel/filters/rename-now', async (req, res) => {
  const s = await getSettings();
  try {
    let r;
    if ((s.protection_bot || 'orbit') === 'orbit') { await loadTrap(); r = await renameTrap('Renamed from the dashboard'); } else {
      r = await sentinelLocal('/renameTrap', {});
      if (!r) throw new Error('Sentinel is not reachable right now.');
      if (!r.ok) throw new Error(r.error || 'Sentinel could not rename the trap.');
    }
    flash(req, 'success', `Renamed #${r.from} to #${r.name}.`);
  } catch (err) {
    flash(req, 'error', err.message);
  }
  res.redirect('/sentinel/filters#rename');
});
