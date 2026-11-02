// Mission Control posts (through Discord webhooks, since the bots stay in BloxVerse only):
//  - #bot-status: "Orbit is online" when a bot starts, "Orbit went offline" when it's stopped or restarted.
//  - updates channel: when new code starts, each bot posts what changed for it (commit titles since its last
//    version, only commits that touch that bot's files; changes to shared files show up for both).
//    Each bot has its own webhooks (Sentinel's are in .env.sentinel), so they can post in their own channels.
// Crashes and a dead phone can't announce themselves; Healthchecks covers those in #incidents.
// Does nothing unless STATUS_WEBHOOK_URL / CHANGELOG_WEBHOOK_URL are set.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BOT } from '../config.js';
import { query } from '../db.js';
import { client } from './client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = BOT === 'sentinel' ? 'Sentinel' : 'Orbit';
const COLOR = BOT === 'sentinel' ? 0xe5484d : 0x1f6feb;
let fetchFn = (...a) => fetch(...a);
let startedAt = Date.now();
export const _setStatusFetch = (fn) => { fetchFn = fn; };

const validHook = (u) => /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(String(u || '').trim());
export const statusHook = () => (validHook(process.env.STATUS_WEBHOOK_URL) ? process.env.STATUS_WEBHOOK_URL.trim() : null);
export const changelogHook = () => (validHook(process.env.CHANGELOG_WEBHOOK_URL) ? process.env.CHANGELOG_WEBHOOK_URL.trim() : null);

/** The code version this process is running: the git commit (read from .git, no git needed). */
export function currentVersion(root = ROOT) {
  try {
    const head = fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 40);
    const ref = head.slice(5).trim();
    const loose = path.join(root, '.git', ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(root, '.git/packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.split(' ')[0] : null;
  } catch {
    return null;
  }
}

// Which files belong to which bot, for the per-bot updates post.
const SENTINEL_ONLY = [
  'src/sentinel', 'src/web/sentinelRoutes.js', 'src/web/views/sentinel', 'src/web/public/sentinel.css', 'src/web/public/sentinel.js',
  ':(glob)assets/sentinel-*', '.env.sentinel.example',
];
// Code both bots run: changes here are news for both.
const SHARED = [
  'src/bot/spamTrap.js', 'src/bot/gifBlock.js', 'src/bot/heartbeat.js', 'src/bot/statusPosts.js', 'src/bot/profile.js',
  'src/bot/client.js', 'src/db.js', 'src/schema.sql', 'src/config.js', 'package.json', 'ecosystem.config.cjs',
];
// Not news for either bot (server art and scripts for Orbit Labs / Mission Control).
const NEITHER = [':(glob)assets/mission-control-*', ':(glob)assets/orbit-labs-*', ':(glob)scripts/mission-control-*'];
const exclude = (list) => list.map((p) => (p.startsWith(':(glob)') ? `:(exclude,glob)${p.slice(7)}` : `:(exclude)${p}`));
export const BOT_PATHS = {
  orbit: ['.', ...exclude(SENTINEL_ONLY), ...exclude(NEITHER)],
  sentinel: [...SENTINEL_ONLY, ...SHARED],
};

/** Commit titles between two versions that touch `paths`, newest first (needs git; returns [] without it). */
export function commitTitles(from, to, root = ROOT, paths = BOT_PATHS[BOT] || BOT_PATHS.orbit) {
  return new Promise((resolve) => {
    if (!from || !to || from === to) return resolve([]);
    execFile('git', ['log', '--format=%s', '-n', '15', `${from}..${to}`, '--', ...paths], { cwd: root, timeout: 5000 }, (err, out) => {
      resolve(err ? [] : out.split('\n').map((l) => l.trim()).filter(Boolean));
    });
  });
}

async function send(url, embed, timeoutMs = 5000) {
  if (!url) return false;
  try {
    const res = await fetchFn(`${url}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: NAME, avatar_url: client.user?.displayAvatarURL?.({ size: 128 }) || undefined, embeds: [embed], allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) console.warn(`[status] webhook answered ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn('[status] could not post:', err.message);
    return false;
  }
}

// Mission Control's #🚨│incidents channel, shown as a clickable link in "went offline" posts.
const INCIDENTS_CHANNEL_ID = (process.env.INCIDENTS_CHANNEL_ID || '1566813720191963328').trim();
const incidentsLink = () => (/^\d{17,20}$/.test(INCIDENTS_CHANNEL_ID) ? `<#${INCIDENTS_CHANNEL_ID}>` : '#🚨│incidents');

const short = (v) => (v ? v.slice(0, 7) : 'unknown');
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

export async function postOnline(now = Date.now()) {
  startedAt = now;
  const v = currentVersion();
  return send(statusHook(), {
    color: 0x2fb27a,
    title: `🟢 ${NAME} is online`,
    description: `Started ${ts(now)} · version \`${short(v)}\``,
    timestamp: new Date(now).toISOString(),
  });
}

export async function postOffline(reason = 'Stopped or restarting (update or maintenance)', now = Date.now()) {
  const upMin = Math.round((now - startedAt) / 60000);
  return send(statusHook(), {
    color: 0x8592a8,
    title: `🔴 ${NAME} went offline`,
    description: `${reason}. It was up for ${upMin >= 60 ? `${Math.floor(upMin / 60)}h ${upMin % 60}m` : `${upMin} min`}.\nIf it isn't back in a few minutes, check ${incidentsLink()}.`,
    timestamp: new Date(now).toISOString(),
  }, 2500); // short: the bot is shutting down
}

const VERSION_KEY = BOT === 'sentinel' ? 'deployed_version_sentinel' : 'deployed_version';

/** If this bot's code changed since its last start, post the commit titles in its updates channel. */
export async function postChangelogIfNew(now = Date.now(), titlesFn = commitTitles) {
  const v = currentVersion();
  if (!v) return { posted: false, reason: 'no version' };
  const { rows } = await query('SELECT value FROM app_secrets WHERE name = $1', [VERSION_KEY]);
  const prev = rows[0]?.value || null;
  if (prev === v) return { posted: false, reason: 'same version' };
  await query('INSERT INTO app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value', [VERSION_KEY, v]);
  if (!prev) return { posted: false, reason: 'first run' }; // nothing to compare with yet
  const titles = await titlesFn(prev, v);
  if (!titles.length) return { posted: false, reason: `nothing new for ${NAME}` }; // this update only touched the other bot
  const ok = await send(changelogHook(), {
    color: COLOR,
    title: '🚀 Update is live',
    description: [
      titles.map((t) => `• ${t}`).join('\n'),
      '',
      `\`${short(prev)}\` → \`${short(v)}\` · ${ts(now)}`,
    ].join('\n').slice(0, 4000),
    timestamp: new Date(now).toISOString(),
  });
  return { posted: ok, titles };
}
