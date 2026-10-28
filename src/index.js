import { config } from './config.js';
import { getOrCreateSecret, migrate, pool } from './db.js';
import { startBot } from './bot/index.js';
import { client } from './bot/client.js';
import { startWeb } from './web/server.js';
import { flushSnapshot } from './bot/counters.js';
import { flushLevels } from './bot/levels.js';
import { flushPresence } from './bot/presence.js';

async function main() {
  await migrate();
  console.log('[db] schema ready');
  if (!config.sessionSecret) config.sessionSecret = await getOrCreateSecret('session');
  startWeb();
  await startBot();
  console.log(`[app] running for server ${config.guildId}`);
}

async function shutdown(signal) {
  console.log(`[app] ${signal} received, shutting down`);
  // Save XP that hasn't been written yet (it is otherwise saved once an hour)
  await flushLevels().then((n) => n && console.log(`[levels] saved ${n} member(s) before shutdown`)).catch((err) => console.warn('[levels] save on shutdown failed:', err.message));
  await flushSnapshot().catch((err) => console.warn('[snapshot] save on shutdown failed:', err.message));
  await flushPresence().catch((err) => console.warn('[presence] save on shutdown failed:', err.message));
  await client.destroy().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

main().catch((err) => {
  console.error('[app] failed to start:', err);
  process.exit(1);
});
