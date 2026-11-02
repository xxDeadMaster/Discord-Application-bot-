// Heartbeat: pings Healthchecks.io every 2 minutes while Orbit is connected to Discord.
// If the pings stop (crash, host down, lost connection), Healthchecks alerts #incidents in Mission Control.
// Does nothing unless HEALTHCHECK_URL is set.
import { client } from './client.js';

const EVERY_MS = 2 * 60 * 1000;
let fetchFn = (...args) => fetch(...args);
let timer = null;

export const heartbeatUrl = () => (process.env.HEALTHCHECK_URL || '').trim();

/** Sends one ping. Skips it when Orbit isn't connected, so a stuck bot shows as down. */
export async function sendHeartbeat() {
  const url = heartbeatUrl();
  if (!url) return { sent: false, reason: 'no url' };
  if (!client.isReady() || client.ws.status !== 0) return { sent: false, reason: 'not connected' };
  try {
    const res = await fetchFn(url, { method: 'POST', body: `ping ${Math.round(client.ws.ping)}ms`, signal: AbortSignal.timeout(10_000) });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    console.warn('[heartbeat] ping failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

export function startHeartbeat() {
  if (!heartbeatUrl() || timer) return false;
  sendHeartbeat();
  timer = setInterval(sendHeartbeat, EVERY_MS);
  timer.unref?.();
  console.log('[heartbeat] pinging Healthchecks every 2 minutes');
  return true;
}

export const _setHeartbeatFetch = (fn) => { fetchFn = fn; };
