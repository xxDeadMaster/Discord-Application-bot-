// Sentinel: BloxVerse's security bot (runs on the phone). Same database as Orbit, no web dashboard of its own.
// Start: npm run sentinel   (needs DISCORD_TOKEN, GUILD_ID, DATABASE_URL; HEALTHCHECK_URL for down alerts)
import './env.js';
import { AuditLogEvent, Events } from 'discord.js';
import { config } from '../config.js';
import { migrate, pool } from '../db.js';
import { client } from '../bot/client.js';
import { startHeartbeat } from '../bot/heartbeat.js';
import { syncProfile } from '../bot/profile.js';
import { postOffline, postOnline } from '../bot/statusPosts.js';
import { gifBlockState, handleGifMessage } from '../bot/gifBlock.js';
import { handleTrapMessage, publishTrap, renameTrap, startTrapRenamer } from '../bot/spamTrap.js';
import { handleAuditEntry } from './antiNuke.js';
import { SENTINEL_COMMANDS, handleSentinelCommand } from './commands.js';
import { handleJoin } from './raid.js';
import { settings } from './state.js';
import { lockdownOff, lockdownOn } from './lockdown.js';
import { flushNow, onBlocked, onJoin, onLeave, onModAction, startLocalService } from './live.js';
import { query } from '../db.js';

const ours = (guildId) => guildId === config.guildId;

let setUp = false;
/** Registers commands, loads settings and starts the heartbeat. Runs at login, or when Sentinel is first invited. */
async function setUpGuild(guild) {
  if (setUp) return;
  setUp = true;
  await guild.commands.set(SENTINEL_COMMANDS).catch((err) => console.error('[sentinel] could not register commands:', err.message));
  const s = await settings({ force: true });
  startHeartbeat();
  startTrapRenamer();
  postOnline().catch(() => {});
  await startLocalService(localHandlers(guild)).catch((err) => console.error('[sentinel] local service failed:', err.message));
  console.log(`[sentinel] ready. Anti-nuke ${s.sentinel_antinuke_enabled ? 'on' : 'off'}, raid ${s.sentinel_raid_joins}/${s.sentinel_raid_seconds}s, trap+GIFs run by ${s.protection_bot}`);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[sentinel] logged in as ${c.user.tag}`);
  syncProfile(c).catch((err) => console.warn('[profile] sync failed:', err.message));
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
    const trapped = await handleTrapMessage(message);
    if (trapped) { if (trapped === 'caught') onBlocked('trap', message); return; }
    if (await handleGifMessage(message)) onBlocked('gif', message);
  } catch (err) {
    console.error('[sentinel message]', err);
  }
});

client.on(Events.MessageUpdate, async (_old, msg) => {
  if (!ours(msg.guildId) || !gifBlockState().enabled || !gifBlockState().active) return;
  const m = msg.partial ? await msg.fetch().catch(() => null) : msg;
  if (m && !m.author?.bot && await handleGifMessage(m).catch((err) => { console.warn('[sentinel gif edit]', err.message); return false; })) onBlocked('gif', m);
});

client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
  if (!ours(guild.id)) return;
  handleAuditEntry(entry, guild).catch((err) => console.error('[anti-nuke]', err));
  recordModAction(entry, guild);
});

/** Bans, kicks and timeouts done by people (not bots) go on the live chart and feed. */
function recordModAction(entry, guild) {
  const by = entry.executor;
  if (!by || by.bot) return;
  let action = null;
  if (entry.action === AuditLogEvent.MemberBanAdd) action = 'banned';
  else if (entry.action === AuditLogEvent.MemberKick) action = 'kicked';
  else if (entry.action === AuditLogEvent.MemberUpdate && (entry.changes || []).some((c) => c.key === 'communication_disabled_until' && c.new)) action = 'timed out';
  if (!action) return;
  const target = entry.target?.username || guild.members.cache.get(entry.targetId)?.user?.username || entry.targetId;
  const mod = guild.members.cache.get(by.id)?.displayName || by.username;
  onModAction({ modName: mod, action, targetName: target, reason: entry.reason });
}

client.on(Events.GuildMemberRemove, (member) => { if (ours(member.guild.id)) onLeave(member); });

/** What Orbit's dashboard can ask Sentinel to do (local only, owner checked by Orbit). */
function localHandlers(guild) {
  const by = (b) => ({ id: b.byId, username: b.byName, tag: b.byName });
  return {
    async lockdown(b) {
      return b.on ? lockdownOn({ guild, by: by(b), reason: b.reason || 'Started from the dashboard' }) : lockdownOff({ guild, by: by(b) });
    },
    async reload() { await settings({ force: true }); return { ok: true }; },
    async renameTrap() {
      await settings({ force: true });
      try { return { ok: true, ...(await renameTrap('Renamed from the dashboard')) }; } catch (err) { return { ok: false, error: err.message }; }
    },
    async publishTrap() {
      await settings({ force: true });
      try { return { ok: true, ...(await publishTrap()) }; } catch (err) { return { ok: false, error: err.message }; }
    },
    async restore(b) {
      const { rows } = await query("SELECT * FROM sentinel_events WHERE id = $1 AND kind = 'nuke'", [b.eventId]);
      const ev = rows[0];
      if (!ev) return { ok: false, error: 'Alert not found.' };
      const member = await guild.members.fetch(ev.actor_id).catch(() => null);
      if (!member) return { ok: false, error: 'They are no longer in the server.' };
      const ids = (ev.detail.removedRoleIds || []).filter((id) => guild.roles.cache.has(id));
      await member.roles.add(ids, `Roles restored from the dashboard by ${b.byName}`);
      await query("UPDATE sentinel_events SET detail = detail || $2 WHERE id = $1", [ev.id, { resolved: 'restored', resolvedBy: b.byName }]);
      return { ok: true, restored: ids.length };
    },
    async ban(b) {
      const { rows } = await query("SELECT * FROM sentinel_events WHERE id = $1", [b.eventId]);
      const ev = rows[0];
      if (!ev?.actor_id) return { ok: false, error: 'Alert not found.' };
      await guild.members.ban(ev.actor_id, { reason: `Banned from the Sentinel dashboard by ${b.byName} (anti-nuke alert #${ev.id})` });
      await query("UPDATE sentinel_events SET detail = detail || $2 WHERE id = $1", [ev.id, { resolved: 'banned', resolvedBy: b.byName }]);
      return { ok: true };
    },
  };
}

client.on(Events.GuildMemberAdd, (member) => {
  if (!ours(member.guild.id)) return;
  onJoin(member);
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
  await postOffline().catch(() => {});
  await flushNow();
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
