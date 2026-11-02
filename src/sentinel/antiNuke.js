// Anti-nuke: watches the audit log. If someone (not the owner, not a trusted ID) deletes channels or roles,
// bans/kicks people or makes webhooks too fast, Sentinel strips their roles (or kicks them if it's a bot)
// and alerts the owner. A bot being added or someone getting admin is reported straight away.
import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { client } from '../bot/client.js';
import { alert } from './alerts.js';
import { settings } from './state.js';

const WINDOW_MS = 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000; // after acting on someone, don't act on them again for 5 minutes

/** Actions that are fine one at a time but mean a nuke when done fast. max = how many in 60s trips it. */
export const LIMITS = {
  [AuditLogEvent.ChannelDelete]: { max: 3, label: 'channels deleted' },
  [AuditLogEvent.RoleDelete]: { max: 3, label: 'roles deleted' },
  [AuditLogEvent.MemberBanAdd]: { max: 5, label: 'members banned' },
  [AuditLogEvent.MemberKick]: { max: 5, label: 'members kicked' },
  [AuditLogEvent.WebhookCreate]: { max: 3, label: 'webhooks created' },
  [AuditLogEvent.ChannelCreate]: { max: 6, label: 'channels created' },
};

const DANGEROUS = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles
  | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ManageWebhooks;

const hits = new Map(); // `${actorId}:${action}` -> [{ at, name }]
const handled = new Map(); // actorId -> when Sentinel last acted on them

/** Counts one action. Returns { count, max, tripped, names }. */
export function countAction(actorId, action, name, now = Date.now()) {
  const limit = LIMITS[action];
  if (!limit) return null;
  const key = `${actorId}:${action}`;
  const list = (hits.get(key) || []).filter((h) => now - h.at < WINDOW_MS);
  list.push({ at: now, name });
  hits.set(key, list);
  return { count: list.length, max: limit.max, tripped: list.length >= limit.max, names: list.map((h) => h.name).filter(Boolean) };
}

const nameOf = (entry) => {
  const c = (entry.changes || []).find((x) => x.key === 'name');
  return c?.old ?? c?.new ?? entry.target?.name ?? entry.target?.username ?? entry.target?.tag ?? entry.targetId ?? null;
};

function isTrusted(actorId, guild, s) {
  return !actorId || actorId === client.user?.id || actorId === guild.ownerId || (s.sentinel_trusted_ids || []).includes(actorId);
}

/** Takes away everything they could keep nuking with. Returns a sentence saying what happened. */
export async function neutralize(guild, actorId, reason) {
  const member = await guild.members.fetch(actorId).catch(() => null);
  if (!member) return 'They are no longer in the server.';
  if (member.user?.bot) {
    if (member.kickable) {
      await member.kick(reason).catch(() => null);
      return 'It is a bot, so Sentinel **kicked it**.';
    }
  }
  const me = guild.members.me;
  const removable = [...member.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed && me && r.comparePositionTo(me.roles.highest) < 0);
  if (removable.length) await member.roles.remove(removable.map((r) => r.id), reason).catch(() => null);
  const fresh = await guild.members.fetch({ user: actorId, force: true }).catch(() => member);
  const stillDangerous = fresh.permissions?.any?.(DANGEROUS);
  if (stillDangerous) return `Sentinel removed ${removable.length} role(s), but **they still have staff powers** (a role above Sentinel's, or they own a bot role). Remove them by hand **now**.`;
  return `Sentinel **removed ${removable.length} role(s)** from them, so they can't do more damage.`;
}

/** Handles one audit log entry. Returns what it did (for tests/logs). */
export async function handleAuditEntry(entry, guild, now = Date.now()) {
  const s = await settings();
  if (!s.sentinel_antinuke_enabled) return { skipped: 'off' };
  const actorId = entry.executorId;
  if (isTrusted(actorId, guild, s)) return { skipped: 'trusted' };
  const actor = entry.executor || (await client.users.fetch(actorId).catch(() => null)) || { id: actorId };
  const who = `<@${actorId}> (${actor.tag || actor.username || actorId})`;

  // Fast destructive actions
  if (LIMITS[entry.action]) {
    const c = countAction(actorId, entry.action, nameOf(entry), now);
    if (!c.tripped) return { counted: c.count };
    if (now - (handled.get(actorId) || 0) < COOLDOWN_MS) return { counted: c.count, already: true };
    handled.set(actorId, now);
    const label = LIMITS[entry.action].label;
    const result = await neutralize(guild, actorId, `Sentinel anti-nuke: ${c.count} ${label} in 60 seconds`);
    await alert({
      kind: 'nuke', guild, actor,
      title: `🛡️ Anti-nuke stopped ${actor.tag || actor.username || actorId}`,
      lines: [
        `${who} had **${c.count} ${label}** in under a minute.`,
        result,
        c.names.length ? `\n**Affected:** ${c.names.slice(0, 15).map((n) => `\`${String(n).slice(0, 40)}\``).join(', ')}` : '',
        '\nCheck **Server Settings → Audit Log** to see everything they did. Deleted channels and roles are not restored automatically.',
      ],
      detail: { action: entry.action, count: c.count, names: c.names.slice(0, 50), result },
    });
    return { tripped: true, result };
  }

  // A bot was added by someone who isn't trusted
  if (entry.action === AuditLogEvent.BotAdd) {
    await alert({
      kind: 'alert', guild, actor, color: 0xffb020,
      title: '🤖 A bot was added to the server',
      lines: [`${who} added **${entry.target?.tag || entry.target?.username || entry.targetId}**.`, 'If you did not expect this, kick the bot and check what roles it has.'],
      detail: { action: entry.action, botId: entry.targetId },
    });
    return { alerted: 'bot' };
  }

  // A role got Administrator
  if (entry.action === AuditLogEvent.RoleUpdate) {
    const p = (entry.changes || []).find((x) => x.key === 'permissions');
    if (p) {
      const before = BigInt(p.old ?? 0);
      const after = BigInt(p.new ?? 0);
      const admin = PermissionFlagsBits.Administrator;
      if ((after & admin) && !(before & admin)) {
        await alert({
          kind: 'alert', guild, actor, color: 0xffb020,
          title: '⚠️ A role was given Administrator',
          lines: [`${who} gave **Administrator** to the role **${entry.target?.name || entry.targetId}**.`],
          detail: { action: entry.action, roleId: entry.targetId },
        });
        return { alerted: 'admin-role' };
      }
    }
  }

  // Someone was given a role with staff powers
  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    const add = (entry.changes || []).find((x) => x.key === '$add');
    const risky = (add?.new || []).map((r) => guild.roles.cache.get(r.id)).filter((r) => r && (BigInt(r.permissions?.bitfield ?? 0) & PermissionFlagsBits.Administrator));
    if (risky.length) {
      await alert({
        kind: 'alert', guild, actor, color: 0xffb020,
        title: '⚠️ Someone was given an admin role',
        lines: [`${who} gave <@${entry.targetId}> the role${risky.length > 1 ? 's' : ''} ${risky.map((r) => `**${r.name}**`).join(', ')} (Administrator).`],
        detail: { action: entry.action, targetId: entry.targetId, roles: risky.map((r) => r.id) },
      });
      return { alerted: 'admin-member' };
    }
  }
  return { ignored: true };
}

export const _antiNukeState = { hits, handled };
