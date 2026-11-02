// Mission Control posts (through Discord webhooks, since the bots stay in BloxVerse only):
//  - #bot-status: "Orbit is online" when a bot starts, "Orbit went offline" when it's stopped or restarted.
//  - #changelog: when new code starts, Orbit posts what changed (the commit titles since the last version).
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

/** Commit titles between two versions, newest first (needs the git command; returns [] without it). */
export function commitTitles(from, to, root = ROOT) {
  return new Promise((resolve) => {
    if (!from || !to || from === to) return resolve([]);
    execFile('git', ['log', '--format=%s', '-n', '15', `${from}..${to}`], { cwd: root, timeout: 5000 }, (err, out) => {
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
    description: `${reason}. It was up for ${upMin >= 60 ? `${Math.floor(upMin / 60)}h ${upMin % 60}m` : `${upMin} min`}.\nIf it isn't back in a few minutes, check #🚨│incidents.`,
    timestamp: new Date(now).toISOString(),
  }, 2500); // short: the bot is shutting down
}

/** Orbit only: if the code changed since the last start, post the commit titles in #changelog. */
export async function postChangelogIfNew(now = Date.now(), titlesFn = commitTitles) {
  const v = currentVersion();
  if (!v) return { posted: false, reason: 'no version' };
  const { rows } = await query("SELECT value FROM app_secrets WHERE name = 'deployed_version'");
  const prev = rows[0]?.value || null;
  if (prev === v) return { posted: false, reason: 'same version' };
  await query("INSERT INTO app_secrets (name, value) VALUES ('deployed_version', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value", [v]);
  if (!prev) return { posted: false, reason: 'first run' }; // nothing to compare with yet
  const titles = await titlesFn(prev, v);
  const ok = await send(changelogHook(), {
    color: COLOR,
    title: '🚀 Update is live',
    description: [
      titles.length ? titles.map((t) => `• ${t}`).join('\n') : 'Behind-the-scenes improvements.',
      '',
      `\`${short(prev)}\` → \`${short(v)}\` · ${ts(now)}`,
    ].join('\n').slice(0, 4000),
    timestamp: new Date(now).toISOString(),
  });
  return { posted: ok, titles };
}
