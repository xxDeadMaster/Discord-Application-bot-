// /giveaway and /poll slash commands: quick ways to run giveaways and polls without the dashboard.
// Managers only (Manage Server, or the manager role in Settings), same as the dashboard tabs.
import { ApplicationCommandOptionType, ChannelType, PermissionFlagsBits } from 'discord.js';
import { getSettings, listGiveaways, listPolls } from '../db.js';
import {
  MAX_POLL_OPTIONS, cancelGiveaway, endGiveaway, endPoll, rerollGiveaway, startGiveaway, startPoll,
} from './giveaways.js';
import { ephemeral, notice, truncate } from './ui.js';

const T = ApplicationCommandOptionType;
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const durationOption = (required, description) => ({
  type: T.String, name: 'duration', description, required, max_length: 30,
});
const idOption = (description) => ({ type: T.Integer, name: 'id', description, required: true, autocomplete: true, min_value: 1 });

export const communityCommandData = [
  {
    name: 'giveaway',
    description: 'Run a giveaway',
    options: [
      { type: T.Subcommand, name: 'start', description: 'Start a giveaway',
        options: [
          { type: T.String, name: 'prize', description: 'What they win, e.g. 1,000 Robux', required: true, max_length: 200 },
          durationOption(true, 'How long it runs, e.g. 30m, 2h, 1d, 1d 12h'),
          { type: T.Integer, name: 'winners', description: 'How many winners (default 1)', min_value: 1, max_value: 20 },
          { type: T.Role, name: 'role', description: 'Only people with this role can enter' },
          { type: T.Channel, name: 'channel', description: 'Where to post it (default: this channel)', channel_types: TEXT_CHANNELS },
          { type: T.String, name: 'details', description: 'Extra text under the prize', max_length: 1000 },
        ] },
      { type: T.Subcommand, name: 'end', description: 'End a giveaway now and pick winners', options: [idOption('Which giveaway')] },
      { type: T.Subcommand, name: 'reroll', description: 'Pick one new winner for an ended giveaway', options: [idOption('Which giveaway')] },
      { type: T.Subcommand, name: 'cancel', description: 'Cancel a giveaway (nobody wins)', options: [idOption('Which giveaway')] },
    ],
  },
  {
    name: 'poll',
    description: 'Run a poll',
    options: [
      { type: T.Subcommand, name: 'create', description: 'Start a poll',
        options: [
          { type: T.String, name: 'question', description: 'What you are asking', required: true, max_length: 250 },
          { type: T.String, name: 'options', description: 'Choices separated by commas, e.g. Obby, Trivia, Build battle', required: true, max_length: 900 },
          durationOption(false, 'Close after, e.g. 30m, 6h, 2d (leave empty to keep it open)'),
          { type: T.Boolean, name: 'multiple', description: 'Let people pick more than one option' },
          { type: T.Channel, name: 'channel', description: 'Where to post it (default: this channel)', channel_types: TEXT_CHANNELS },
        ] },
      { type: T.Subcommand, name: 'end', description: 'Close a poll and show the final results', options: [idOption('Which poll')] },
    ],
  },
];

/* ---------- Parsing ---------- */

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const MAX_MS = 30 * 86_400_000;

/**
 * "30m", "2h", "1d 12h", "1 day", "90" (minutes). Returns ms, or null if it isn't a valid
 * length between 1 minute and 30 days.
 */
export function parseDuration(text) {
  const s = String(text || '').toLowerCase().replace(/,/g, ' ').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) { const ms = Number(s) * UNIT_MS.m; return ms >= UNIT_MS.m && ms <= MAX_MS ? ms : null; }
  const re = /(\d+(?:\.\d+)?)\s*(w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?)\b/g;
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * UNIT_MS[m[2][0]];
    matched += m[0];
  }
  if (!total || matched.replace(/\s/g, '').length !== s.replace(/\s/g, '').length) return null;
  return total >= UNIT_MS.m && total <= MAX_MS ? Math.round(total) : null;
}

/** "Obby, Trivia | Build battle" -> ['Obby', 'Trivia', 'Build battle'] (pipes win if used). */
export function parseOptions(text) {
  const raw = String(text || '');
  const parts = raw.includes('|') ? raw.split('|') : raw.split(',');
  const seen = new Set();
  return parts.map((p) => p.trim().slice(0, 80)).filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
}

/* ---------- Handlers ---------- */

function canManage(member, settings) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(settings?.manager_role_id && member.roles?.cache?.has(settings.manager_role_id));
}

const reply = (interaction, text, kind) => (interaction.deferred
  ? interaction.editReply({ embeds: [notice(text, kind)] })
  : interaction.reply({ embeds: [notice(text, kind)], flags: ephemeral }));

const jump = (guildId, channelId, messageId) => (messageId ? ` [Jump to it](https://discord.com/channels/${guildId}/${channelId}/${messageId})` : '');

export async function handleCommunityCommand(interaction) {
  const settings = await getSettings();
  if (!canManage(interaction.member, settings)) {
    return reply(interaction, `Only managers can run ${interaction.commandName === 'poll' ? 'polls' : 'giveaways'}.`, 'blocked');
  }
  const sub = interaction.options.getSubcommand();
  const channel = interaction.options.getChannel('channel') || interaction.channel;

  if (interaction.commandName === 'giveaway') {
    if (sub === 'start') {
      const ms = parseDuration(interaction.options.getString('duration'));
      if (!ms) return reply(interaction, 'I could not read that length. Try something like `30m`, `2h`, `1d` or `1d 12h` (1 minute to 30 days).', 'error');
      await interaction.deferReply({ flags: ephemeral });
      const role = interaction.options.getRole('role');
      try {
        const g = await startGiveaway({
          channelId: channel.id,
          prize: interaction.options.getString('prize').trim(),
          description: interaction.options.getString('details')?.trim() || '',
          winnerCount: interaction.options.getInteger('winners') || 1,
          requiredRoleId: role && role.id !== interaction.guildId ? role.id : null,
          endsAt: new Date(Date.now() + ms),
          hostId: interaction.user.id,
          hostTag: interaction.user.tag || interaction.user.username,
        });
        return reply(interaction, `🎉 Giveaway **#${g.id}** for **${truncate(g.prize, 200)}** is live in <#${g.channel_id}>.${jump(interaction.guildId, g.channel_id, g.message_id)}`, 'success');
      } catch (err) {
        return reply(interaction, err.message, 'error');
      }
    }
    await interaction.deferReply({ flags: ephemeral });
    const id = interaction.options.getInteger('id');
    const r = sub === 'end' ? await endGiveaway(id) : sub === 'reroll' ? await rerollGiveaway(id, 1) : await cancelGiveaway(id);
    const done = { end: 'Giveaway ended and the winners were announced.', reroll: 'Picked a new winner and announced it.', cancel: 'Giveaway cancelled.' }[sub];
    return reply(interaction, r.ok ? done : r.error, r.ok ? 'success' : 'error');
  }

  if (interaction.commandName === 'poll') {
    if (sub === 'create') {
      const options = parseOptions(interaction.options.getString('options'));
      if (options.length < 2) return reply(interaction, 'Add at least 2 choices, separated by commas. Example: `Obby, Trivia, Build battle`', 'error');
      if (options.length > MAX_POLL_OPTIONS) return reply(interaction, `Polls can have up to ${MAX_POLL_OPTIONS} choices.`, 'error');
      const durationText = interaction.options.getString('duration');
      const ms = durationText ? parseDuration(durationText) : null;
      if (durationText && !ms) return reply(interaction, 'I could not read that length. Try `30m`, `6h` or `2d`, or leave it empty.', 'error');
      await interaction.deferReply({ flags: ephemeral });
      try {
        const p = await startPoll({
          channelId: channel.id,
          question: interaction.options.getString('question').trim(),
          options,
          multi: Boolean(interaction.options.getBoolean('multiple')),
          endsAt: ms ? new Date(Date.now() + ms) : null,
          hostId: interaction.user.id,
          hostTag: interaction.user.tag || interaction.user.username,
        });
        return reply(interaction, `📊 Poll **#${p.id}** is live in <#${p.channel_id}>.${jump(interaction.guildId, p.channel_id, p.message_id)}`, 'success');
      } catch (err) {
        return reply(interaction, err.message, 'error');
      }
    }
    await interaction.deferReply({ flags: ephemeral });
    const r = await endPoll(interaction.options.getInteger('id'));
    return reply(interaction, r.ok ? 'Poll closed. The final results are showing in Discord.' : r.error, r.ok ? 'success' : 'error');
  }
  return null;
}

/** Suggests giveaways / polls for the `id` option as people type. */
export async function handleCommunityAutocomplete(interaction) {
  const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
  const sub = interaction.options.getSubcommand();
  let items = [];
  if (interaction.commandName === 'giveaway') {
    const status = sub === 'reroll' ? 'ended' : 'active';
    items = (await listGiveaways({ status, limit: 50 })).map((g) => ({ id: g.id, label: `#${g.id} · ${g.prize} · ${g.entry_count} entr${g.entry_count === 1 ? 'y' : 'ies'}` }));
  } else if (interaction.commandName === 'poll') {
    items = (await listPolls({ limit: 50 })).filter((p) => p.status === 'active').map((p) => ({ id: p.id, label: `#${p.id} · ${p.question}` }));
  }
  const choices = items
    .filter((i) => !typed || i.label.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((i) => ({ name: truncate(i.label, 100), value: i.id }));
  return interaction.respond(choices).catch(() => {});
}
