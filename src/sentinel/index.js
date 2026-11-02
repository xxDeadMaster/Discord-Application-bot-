// Sentinel: BloxVerse's security bot (runs on the phone). Same database as Orbit, no web dashboard of its own.
// Start: npm run sentinel   (needs DISCORD_TOKEN, GUILD_ID, DATABASE_URL; HEALTHCHECK_URL for down alerts)
import './env.js';
import { Events } from 'discord.js';
import { config } from '../config.js';
import { migrate, pool } from '../db.js';
import { client } from '../bot/client.js';
import { startHeartbeat } from '../bot/heartbeat.js';
import { gifBlockState, handleGifMessage } from '../bot/gifBlock.js';
import { handleTrapMessage } from '../bot/spamTrap.js';
import { handleAuditEntry } from './antiNuke.js';
import { SENTINEL_COMMANDS, handleSentinelCommand } from './commands.js';
import { handleJoin } from './raid.js';
import { settings } from './state.js';

const ours = (guildId) => guildId === config.guildId;

let setUp = false;
/** Registers commands, loads settings and starts the heartbeat. Runs at login, or when Sentinel is first invited. */
async function setUpGuild(guild) {
  if (setUp) return;
  setUp = true;
  await guild.commands.set(SENTINEL_COMMANDS).catch((err) => console.error('[sentinel] could not register commands:', err.message));
  const s = await settings({ force: true });
  startHeartbeat();
  console.log(`[sentinel] ready. Anti-nuke ${s.sentinel_antinuke_enabled ? 'on' : 'off'}, raid ${s.sentinel_raid_joins}/${s.sentinel_raid_seconds}s, trap+GIFs run by ${s.protection_bot}`);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[sentinel] logged in as ${c.user.tag}`);
  for (const g of c.guilds.cache.values()) {
    if (!ours(g.id)) { console.warn(`[sentinel] leaving ${g.name}`); await g.leave().catch(() => {}); }
  }
  const guild = await c.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) { console.warn('[sentinel] not in BloxVerse yet. Invite it.'); return; }
  await setUpGuild(guild).catch((err) => console.error('[sentinel] setup failed:', err));
});

client.on(Events.GuildCreate, (g) => {
  if (!ours(g.id)) { g.leave().catch(() => {}); return; }
  console.log('[sentinel] added to BloxVerse');
  setUpGuild(g).catch((err) => console.error('[sentinel] setup failed:', err));
});

client.on(Events.MessageCreate, async (message) => {
  if (!ours(message.guildId) || message.author?.bot) return;
  try {
    await settings(); // refreshes trap/GIF settings at most every 2 minutes
    if (await handleTrapMessage(message)) return;
    await handleGifMessage(message);
  } catch (err) {
    console.error('[sentinel message]', err);
  }
});

client.on(Events.MessageUpdate, async (_old, msg) => {
  if (!ours(msg.guildId) || !gifBlockState().enabled || !gifBlockState().active) return;
  const m = msg.partial ? await msg.fetch().catch(() => null) : msg;
  if (m && !m.author?.bot) await handleGifMessage(m).catch((err) => console.warn('[sentinel gif edit]', err.message));
});

client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
  if (!ours(guild.id)) return;
  handleAuditEntry(entry, guild).catch((err) => console.error('[anti-nuke]', err));
});

client.on(Events.GuildMemberAdd, (member) => {
  if (!ours(member.guild.id)) return;
  handleJoin(member).catch((err) => console.error('[raid]', err));
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || !ours(i.guildId)) return;
  try {
    await handleSentinelCommand(i);
  } catch (err) {
    console.error(`[sentinel /${i.commandName}]`, err);
    const msg = { content: 'Something went wrong.', flags: 64 };
    if (i.deferred || i.replied) await i.editReply(msg).catch(() => {}); else await i.reply(msg).catch(() => {});
  }
});

client.on(Events.Error, (err) => console.error('[discord]', err));

async function shutdown(signal) {
  console.log(`[sentinel] ${signal}, shutting down`);
  await client.destroy().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

(async () => {
  await migrate();
  await client.login(config.token);
})().catch((err) => {
  console.error('[sentinel] failed to start:', err);
  process.exit(1);
});
