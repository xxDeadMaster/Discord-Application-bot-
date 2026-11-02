// Sentinel keeps settings in memory and re-reads them at most every 2 minutes, and only when
// something happens (a message, a join, a command). So Sentinel never wakes the database on its own.
import { getSettings } from '../db.js';
import { loadTrap } from '../bot/spamTrap.js';
import { loadGifBlock } from '../bot/gifBlock.js';

const TTL_MS = 2 * 60 * 1000;
let cache = null;
let loadedAt = 0;
let loading = null;

export async function settings({ force = false, now = Date.now() } = {}) {
  if (!force && cache && now - loadedAt < TTL_MS) return cache;
  if (!loading) {
    loading = (async () => {
      const s = await getSettings();
      await Promise.all([loadTrap(), loadGifBlock()]);
      cache = s;
      loadedAt = Date.now();
      return s;
    })().finally(() => { loading = null; });
  }
  return loading;
}

export const cachedSettings = () => cache;
export const _resetState = () => { cache = null; loadedAt = 0; };
