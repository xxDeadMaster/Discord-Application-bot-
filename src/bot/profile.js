// Sets the bot's Discord profile (name, avatar, banner, app icon and description) to its look (Orbit or Sentinel).
// Runs once per profile version, so restarts don't keep re-uploading (Discord rate-limits these).
import fs from 'node:fs';
import { BOT } from '../config.js';
import { query } from '../db.js';

const PROFILES = {
  orbit: {
    version: 'orbit-1', key: 'profile_version', name: 'Orbit', logo: 'orbit-logo-512.png', banner: 'orbit-banner.png',
    description: 'The BloxVerse Community assistant. Staff applications, support tickets and staff tools. Everything orbits around here.',
  },
  sentinel: {
    version: 'sentinel-1', key: 'profile_version_sentinel', name: 'Sentinel', logo: 'sentinel-logo-512.png', banner: 'sentinel-banner.png',
    description: "The BloxVerse Community security bot. Anti-nuke, raid alarm, lockdowns, spam trap and GIF filter. Always on watch, so staff don't have to be.",
  },
};
const P = PROFILES[BOT];
const PROFILE_VERSION = P.version;
const NAME = P.name;
const DESCRIPTION = P.description;
const asset = (name) => fs.readFileSync(new URL(`../../assets/${name}`, import.meta.url));
export const profileFor = (bot) => PROFILES[bot];

export async function syncProfile(client) {
  const { rows } = await query('SELECT value FROM app_secrets WHERE name = $1', [P.key]);
  if (rows[0]?.value === PROFILE_VERSION) return;

  const done = [];
  const failed = [];
  const step = async (label, fn) => {
    try { await fn(); done.push(label); } catch (err) { failed.push(`${label} (${err.message})`); }
  };

  const logo = asset(P.logo);
  await step('avatar', () => client.user.setAvatar(logo));
  await step('banner', () => client.user.setBanner(asset(P.banner)));
  if (client.user.username !== NAME) await step('name', () => client.user.setUsername(NAME));
  await step('app icon + description', () => client.application.edit({
    icon: `data:image/png;base64,${logo.toString('base64')}`,
    description: DESCRIPTION,
  }));

  console.log(`[profile] updated: ${done.join(', ') || 'nothing'}${failed.length ? ` · failed: ${failed.join('; ')}` : ''}`);
  // Only mark as done when the important parts worked; otherwise try again next start
  if (done.includes('avatar') && (done.includes('name') || client.user.username === NAME)) {
    await query(
      'INSERT INTO app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value',
      [P.key, PROFILE_VERSION],
    );
  }
}
