// Sets the bot's Discord profile (name, avatar, banner, app icon and description) to the Orbit look.
// Runs once per PROFILE_VERSION, so restarts don't keep re-uploading (Discord rate-limits these).
import fs from 'node:fs';
import { query } from '../db.js';

const PROFILE_VERSION = 'orbit-1';
const NAME = 'Orbit';
const DESCRIPTION = 'The BloxVerse Community assistant. Staff applications, support tickets and staff tools. Everything orbits around here.';
const asset = (name) => fs.readFileSync(new URL(`../../assets/${name}`, import.meta.url));

export async function syncProfile(client) {
  const { rows } = await query(`SELECT value FROM app_secrets WHERE name = 'profile_version'`);
  if (rows[0]?.value === PROFILE_VERSION) return;

  const done = [];
  const failed = [];
  const step = async (label, fn) => {
    try { await fn(); done.push(label); } catch (err) { failed.push(`${label} (${err.message})`); }
  };

  const logo = asset('orbit-logo-512.png');
  await step('avatar', () => client.user.setAvatar(logo));
  await step('banner', () => client.user.setBanner(asset('orbit-banner.png')));
  if (client.user.username !== NAME) await step('name', () => client.user.setUsername(NAME));
  await step('app icon + description', () => client.application.edit({
    icon: `data:image/png;base64,${logo.toString('base64')}`,
    description: DESCRIPTION,
  }));

  console.log(`[profile] updated: ${done.join(', ') || 'nothing'}${failed.length ? ` · failed: ${failed.join('; ')}` : ''}`);
  // Only mark as done when the important parts worked; otherwise try again next start
  if (done.includes('avatar') && (done.includes('name') || client.user.username === NAME)) {
    await query(
      `INSERT INTO app_secrets (name, value) VALUES ('profile_version', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      [PROFILE_VERSION],
    );
  }
}
