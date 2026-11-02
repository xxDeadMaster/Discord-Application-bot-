// Sentinel's live view: what happened in the last hour (kept in memory), an hourly summary saved to the
// database only when something happened, and a tiny local-only web service that Orbit's dashboard reads
// (both bots run on the same phone, so nothing is exposed to the internet).
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { getOrCreateSecret, query } from '../db.js';
import { client } from '../bot/client.js';

export const KINDS = ['joins', 'leaves', 'blocked', 'mod'];
const MINUTES = 60;
const FEED_MAX = 150;

let minutes = []; // [{ t: minute start ms, joins, leaves, blocked, mod }]
let hour = null; // { t: hour start ms, joins, leaves, blocked, mod, blockedBy: {} } - flushed to DB when the hour ends
let feed = []; // newest first: { id, at, f, sev, who, text, meta }
let feedSeq = 0;
const startedAt = Date.now();

const floorMin = (ms) => ms - (ms % 60000);
const floorHour = (ms) => ms - (ms % 3600000);
const blank = (t) => ({ t, joins: 0, leaves: 0, blocked: 0, mod: 0 });

function bucket(now) {
  const t = floorMin(now);
  const last = minutes.at(-1);
  if (!last || last.t !== t) {
    minutes.push(blank(t));
    minutes = minutes.filter((m) => now - m.t < MINUTES * 60000);
  }
  const h = floorHour(now);
  if (!hour || hour.t !== h) {
    if (hour) flushHour(hour).catch((err) => console.warn('[sentinel live] could not save hour:', err.message));
    hour = { ...blank(h), blockedBy: {} };
  }
  return minutes.at(-1);
}

/** Saves an hour's totals (only if something happened, so a quiet server never wakes the database). */
export async function flushHour(h) {
  if (!h || !KINDS.some((k) => h[k])) return false;
  await query(
    `INSERT INTO sentinel_activity (guild_id, hour, joins, leaves, blocked, mod) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (guild_id, hour) DO UPDATE SET joins = sentinel_activity.joins + EXCLUDED.joins,
       leaves = sentinel_activity.leaves + EXCLUDED.leaves, blocked = sentinel_activity.blocked + EXCLUDED.blocked,
       mod = sentinel_activity.mod + EXCLUDED.mod`,
    [config.guildId, new Date(h.t), h.joins, h.leaves, h.blocked, h.mod],
  );
  return true;
}

/** Counts one thing on the chart. kind: joins | leaves | blocked | mod. */
export function count(kind, now = Date.now(), by = null) {
  const m = bucket(now);
  m[kind] += 1;
  hour[kind] += 1;
  if (kind === 'blocked' && by) hour.blockedBy[by] = (hour.blockedBy[by] || 0) + 1;
}

/** Adds a line to the live feed. f: join | blocked | mod | nuke | raid | lock. sev: ok | warn | bad | info */
export function addFeed({ f, sev = 'info', who = '', text, meta = '' }, now = Date.now()) {
  feed.unshift({ id: ++feedSeq, at: now, f, sev, who: String(who).slice(0, 60), text: String(text).slice(0, 200), meta: String(meta).slice(0, 160) });
  if (feed.length > FEED_MAX) feed.length = FEED_MAX;
}

const ageText = (created, now) => {
  if (!created) return 'Account age unknown';
  const days = (now - created) / 86400000;
  if (days < 1) return `Account made ${Math.max(1, Math.round(days * 24))} hour${Math.round(days * 24) === 1 ? '' : 's'} ago`;
  if (days < 30) return `Account made ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} ago`;
  if (days < 365) return `Account ${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? '' : 's'} old`;
  return `Account ${Math.floor(days / 365)} year${Math.floor(days / 365) === 1 ? '' : 's'} old`;
};

export function onJoin(member, now = Date.now()) {
  count('joins', now);
  const created = member.user?.createdTimestamp || 0;
  const young = created && now - created < 7 * 86400000;
  addFeed({ f: 'join', sev: young ? 'warn' : 'ok', who: member.user?.username || member.id, text: `${member.user?.username || member.id} joined`, meta: ageText(created, now) }, now);
}

export function onLeave(member, now = Date.now()) {
  count('leaves', now);
}

export function onBlocked(kind, message, now = Date.now()) {
  count('blocked', now, kind);
  const who = message.author?.username || message.author?.id || 'someone';
  const where = message.channel?.name ? `#${message.channel.name}` : 'a channel';
  addFeed(kind === 'trap'
    ? { f: 'blocked', sev: 'bad', who, text: `Spam trap caught ${who}`, meta: 'Removed · last hour of messages deleted' }
    : { f: 'blocked', sev: 'info', who, text: `GIF deleted in ${where}`, meta: `from ${who}` }, now);
}

export function onModAction({ modName, action, targetName, reason }, now = Date.now()) {
  count('mod', now);
  addFeed({ f: 'mod', sev: 'warn', who: modName, text: `${modName} ${action} ${targetName}`, meta: reason || 'No reason given' }, now);
}

/** Battery and temperature, only if the Termux:API app is installed. Cached for a minute. */
let phoneCache = { at: 0, value: null };
function phoneStats() {
  if (Date.now() - phoneCache.at < 60000) return Promise.resolve(phoneCache.value);
  return new Promise((resolve) => {
    execFile('termux-battery-status', { timeout: 4000 }, (err, out) => {
      let value = null;
      if (!err) { try { const b = JSON.parse(out); value = { battery: b.percentage, temp: b.temperature, charging: b.status === 'CHARGING' || b.plugged !== 'UNPLUGGED' }; } catch { value = null; } }
      phoneCache = { at: Date.now(), value };
      resolve(value);
    });
  });
}

/** Everything the dashboard's live view needs. */
export async function snapshot(now = Date.now()) {
  bucket(now);
  const series = {};
  for (const k of KINDS) {
    series[k] = Array.from({ length: MINUTES }, (_, i) => {
      const t = floorMin(now) - (MINUTES - 1 - i) * 60000;
      return minutes.find((m) => m.t === t)?.[k] || 0;
    });
  }
  const tenMin = minutes.filter((m) => now - m.t < 10 * 60000).reduce((a, m) => a + m.joins, 0);
  return {
    online: client.isReady?.() || false,
    ping: Math.round(client.ws?.ping ?? -1),
    uptimeMin: Math.round((now - startedAt) / 60000),
    memory: { freeMb: Math.round(os.freemem() / 1048576), totalMb: Math.round(os.totalmem() / 1048576), botMb: Math.round(process.memoryUsage().rss / 1048576) },
    phone: await phoneStats(),
    minute: series,
    hourNow: hour ? { t: hour.t, joins: hour.joins, leaves: hour.leaves, blocked: hour.blocked, mod: hour.mod, blockedBy: hour.blockedBy } : null,
    joins10: tenMin,
    feed: feed.slice(0, 60),
  };
}

/* ---------- Local service for Orbit (127.0.0.1 only, shared secret) ---------- */

export const LOCAL_PORT = Number(process.env.SENTINEL_LOCAL_PORT) || 3101;
let server = null;

/** handlers: { lockdown({ on, byId, byName, reason }), reload(), restore({ eventId, byName }) } */
export async function startLocalService(handlers) {
  if (server) return server;
  const secret = await getOrCreateSecret('sentinel_local');
  server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-sentinel-key'] !== secret) return send(403, { error: 'forbidden' });
    try {
      if (req.method === 'GET' && req.url === '/live') return send(200, await snapshot());
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 10000) return send(413, { error: 'too big' }); }
        const body = raw ? JSON.parse(raw) : {};
        const name = req.url.slice(1);
        if (!handlers[name]) return send(404, { error: 'unknown' });
        return send(200, (await handlers[name](body)) || { ok: true });
      }
      return send(404, { error: 'unknown' });
    } catch (err) {
      console.error('[sentinel local]', err);
      return send(500, { error: err.message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(LOCAL_PORT, '127.0.0.1', resolve); });
  console.log(`[sentinel] local service on 127.0.0.1:${LOCAL_PORT}`);
  return server;
}

export async function flushNow() {
  if (hour) await flushHour(hour).catch(() => {});
  hour = hour ? { ...blank(hour.t), blockedBy: {} } : null;
}

export const _liveState = { reset() { minutes = []; hour = null; feed = []; feedSeq = 0; }, get hour() { return hour; } };
