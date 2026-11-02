// Sentinel's slash commands: /lockdown and /sentinel (settings + status). All replies are private.
import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { updateSettings } from '../db.js';
import { client } from '../bot/client.js';
import { heartbeatUrl } from '../bot/heartbeat.js';
import { SENTINEL_RED, recentEvents, sentinelFooter } from './alerts.js';
import { lockdownOff, lockdownOn } from './lockdown.js';
import { settings } from './state.js';

const ephemeral = MessageFlags.Ephemeral;

export const SENTINEL_COMMANDS = [
  new SlashCommandBuilder().setName('lockdown').setDescription('Stop members from sending messages everywhere (staff can still talk)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((c) => c.setName('on').setDescription('Lock the server')
      .addStringOption((o) => o.setName('reason').setDescription('Why (shown in the alert)').setMaxLength(200)))
    .addSubcommand((c) => c.setName('off').setDescription('Lift the lockdown and put every channel back how it was')),
  new SlashCommandBuilder().setName('sentinel').setDescription('Sentinel security settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((c) => c.setName('status').setDescription('What Sentinel is watching, and recent alerts'))
    .addSubcommand((c) => c.setName('log-channel').setDescription('Where Sentinel posts alerts')
      .addChannelOption((o) => o.setName('channel').setDescription('A staff-only channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((c) => c.setName('trust').setDescription('Owner only: anti-nuke skips this person or bot')
      .addUserOption((o) => o.setName('user').setDescription('Person or bot').setRequired(true)))
    .addSubcommand((c) => c.setName('untrust').setDescription('Owner only: anti-nuke watches this person or bot again')
      .addUserOption((o) => o.setName('user').setDescription('Person or bot').setRequired(true)))
    .addSubcommand((c) => c.setName('anti-nuke').setDescription('Owner only: turn anti-nuke on or off')
      .addBooleanOption((o) => o.setName('on').setDescription('On or off').setRequired(true)))
    .addSubcommand((c) => c.setName('raid').setDescription('Raid alarm: how many joins, how fast, and whether to lock automatically')
      .addIntegerOption((o) => o.setName('joins').setDescription('Joins that count as a raid (default 8)').setMinValue(3).setMaxValue(100).setRequired(true))
      .addIntegerOption((o) => o.setName('seconds').setDescription('Within this many seconds (default 60)').setMinValue(10).setMaxValue(600).setRequired(true))
      .addBooleanOption((o) => o.setName('auto_lockdown').setDescription('Lock the server automatically when a raid starts').setRequired(true)))
    .addSubcommand((c) => c.setName('lock-role').setDescription('Add or remove a member role that /lockdown also locks (besides @everyone)')
      .addRoleOption((o) => o.setName('role').setDescription('For example the Verified role').setRequired(true))),
].map((c) => c.toJSON());

const isOwner = (i) => i.user.id === i.guild.ownerId;
const isAdmin = (i) => isOwner(i) || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
function isStaff(i, s) {
  if (isAdmin(i)) return true;
  const roles = i.member?.roles?.cache;
  return [s.staff_role_id, s.manager_role_id].some((r) => r && roles?.has(r));
}
const say = (i, content) => (i.deferred || i.replied ? i.editReply({ content }) : i.reply({ content, flags: ephemeral }));

export async function handleSentinelCommand(i) {
  const s = await settings({ force: true });
  if (i.commandName === 'lockdown') {
    if (!isStaff(i, s)) return say(i, 'Only staff can use this.');
    const sub = i.options.getSubcommand();
    await i.deferReply({ flags: ephemeral });
    if (sub === 'on') {
      const r = await lockdownOn({ guild: i.guild, by: i.user, reason: i.options.getString('reason') || '' });
      if (r.already) return say(i, 'The server is already locked. Use `/lockdown off` to lift it.');
      if (r.nothing) return say(i, 'Nothing to lock: members already can\'t send messages anywhere.');
      return say(i, `🔒 Locked **${r.channels}** channel${r.channels === 1 ? '' : 's'}.${r.failed ? ` ${r.failed} change(s) failed (missing permissions?).` : ''} Lift it with \`/lockdown off\`.`);
    }
    if (!s.sentinel_lockdown_active) return say(i, 'The server isn\'t locked.');
    const r = await lockdownOff({ guild: i.guild, by: i.user });
    return say(i, r.failed ? `🔓 Restored ${r.channels} channels, but ${r.failed} change(s) failed. Run \`/lockdown off\` again.` : `🔓 Lockdown lifted. ${r.channels} channel${r.channels === 1 ? '' : 's'} are back to how they were.`);
  }

  if (i.commandName !== 'sentinel') return null;
  const sub = i.options.getSubcommand();
  if (!isAdmin(i)) return say(i, 'Only admins can change Sentinel.');

  if (sub === 'status') {
    const events = await recentEvents(5);
    const e = new EmbedBuilder().setColor(SENTINEL_RED).setTitle('🛡️ Sentinel status').addFields(
      { name: 'Anti-nuke', value: s.sentinel_antinuke_enabled ? `On · ${(s.sentinel_trusted_ids || []).length} trusted` : 'Off', inline: true },
      { name: 'Raid alarm', value: `${s.sentinel_raid_joins} joins / ${s.sentinel_raid_seconds}s${s.sentinel_auto_lockdown ? ' · auto-lock' : ''}`, inline: true },
      { name: 'Lockdown', value: s.sentinel_lockdown_active ? '🔒 **Active**' : 'Off', inline: true },
      { name: 'Alerts go to', value: s.sentinel_log_channel_id ? `<#${s.sentinel_log_channel_id}>` : 'Not set (DMs to the owner only)', inline: true },
      { name: 'Spam trap + GIFs', value: s.protection_bot === 'sentinel' ? 'Run by Sentinel' : 'Run by Orbit', inline: true },
      { name: 'Ping', value: `${Math.round(client.ws.ping)} ms${heartbeatUrl() ? ' · heartbeat on' : ''}`, inline: true },
      { name: 'Recent alerts', value: events.length ? events.map((x) => `<t:${Math.floor(new Date(x.created_at).getTime() / 1000)}:R> ${x.summary}`).join('\n').slice(0, 1024) : 'None' },
    ).setFooter(sentinelFooter());
    return i.reply({ embeds: [e], flags: ephemeral });
  }
  if (sub === 'log-channel') {
    const ch = i.options.getChannel('channel');
    await updateSettings({ sentinel_log_channel_id: ch.id });
    await settings({ force: true });
    return say(i, `Alerts will be posted in ${ch}. Make sure it's staff-only.`);
  }
  if (sub === 'trust' || sub === 'untrust' || sub === 'anti-nuke') {
    if (!isOwner(i)) return say(i, 'Only the server owner can change this.');
    if (sub === 'anti-nuke') {
      const on = i.options.getBoolean('on');
      await updateSettings({ sentinel_antinuke_enabled: on });
      await settings({ force: true });
      return say(i, on ? '🛡️ Anti-nuke is on.' : 'Anti-nuke is off. Sentinel will not stop mass deletes or bans.');
    }
    const user = i.options.getUser('user');
    const list = new Set(s.sentinel_trusted_ids || []);
    if (sub === 'trust') list.add(user.id); else list.delete(user.id);
    await updateSettings({ sentinel_trusted_ids: [...list] });
    await settings({ force: true });
    return say(i, sub === 'trust' ? `${user} is trusted: anti-nuke will ignore them. Only trust people and bots you fully trust.` : `${user} is no longer trusted.`);
  }
  if (sub === 'raid') {
    const joins = i.options.getInteger('joins');
    const seconds = i.options.getInteger('seconds');
    const auto = i.options.getBoolean('auto_lockdown');
    await updateSettings({ sentinel_raid_joins: joins, sentinel_raid_seconds: seconds, sentinel_auto_lockdown: auto });
    await settings({ force: true });
    return say(i, `Raid alarm: **${joins} joins in ${seconds} seconds**.${auto ? ' Sentinel will lock the server automatically.' : ' Sentinel will alert you; lock with `/lockdown on`.'}`);
  }
  if (sub === 'lock-role') {
    const role = i.options.getRole('role');
    if (role.id === i.guild.id) return say(i, '@everyone is always locked.');
    const list = new Set(s.sentinel_lockdown_role_ids || []);
    const adding = !list.has(role.id);
    if (adding) list.add(role.id); else list.delete(role.id);
    await updateSettings({ sentinel_lockdown_role_ids: [...list] });
    await settings({ force: true });
    return say(i, adding ? `/lockdown will also lock **${role.name}**.` : `/lockdown won't lock **${role.name}** any more.`);
  }
  return null;
}
