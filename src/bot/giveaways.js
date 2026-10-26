// Giveaways (join button, timer, required role, reroll) and polls (button voting with live bars).
// Active ones are kept in memory with their end times, so the timer check doesn't wake the database.
// Message edits after each click are batched (at most one edit every few seconds per message)
// to stay well inside Discord's rate limits on busy giveaways.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { randomInt } from 'node:crypto';
import {
  createGiveaway, getSettings, createPoll, getGiveaway, getPoll, giveawayEntrants, listGiveaways, listPolls, pollResults,
  toggleGiveawayEntry, updateGiveaway, updatePoll, votePoll,
} from '../db.js';
import { client } from './client.js';
import {
  COLORS, ephemeral, footer, notice, truncate, unix,
} from './ui.js';

const GOLD = 0xffc24b;
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
export const MAX_POLL_OPTIONS = 10;

/* ---------- Shared helpers ---------- */

const timers = new Map(); // 'g:<id>' | 'p:<id>' -> ends_at ms
const dirty = new Set(); // 'g:<id>' | 'p:<id>' waiting for a message refresh

async function fetchMessage(channelId, messageId) {
  if (!channelId || !messageId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.messages?.fetch(messageId).catch(() => null) ?? null;
}

async function postTo(channelId, payload) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('The bot cannot find that channel.');
  try {
    return await channel.send(payload);
  } catch (err) {
    throw new Error(`The bot could not post there (${err.message}). Give it Send Messages and Embed Links.`);
  }
}

/** Picks up to n different items at random (crypto-strong). */
export function pickRandom(list, n) {
  const pool = [...list];
  const out = [];
  while (pool.length && out.length < n) out.push(pool.splice(randomInt(pool.length), 1)[0]);
  return out;
}

/* ---------- Giveaways ---------- */

export function giveawayMessage(g, entryCount = g.entry_count ?? 0) {
  const active = g.status === 'active';
  const lines = [];
  if (g.description) lines.push(g.description, '');
  if (active) {
    lines.push(`⏰ Ends <t:${unix(g.ends_at)}:R> (<t:${unix(g.ends_at)}:f>)`);
  } else if (g.status === 'ended') {
    lines.push(`⏰ Ended <t:${unix(g.ended_at || g.ends_at)}:R>`);
    lines.push(g.winner_ids?.length ? `🏆 **Winner${g.winner_ids.length === 1 ? '' : 's'}:** ${g.winner_ids.map((id) => `<@${id}>`).join(', ')}` : '😢 Nobody entered, so there is no winner.');
  } else {
    lines.push('🚫 This giveaway was cancelled.');
  }
  lines.push(`🎟️ **${entryCount}** ${entryCount === 1 ? 'entry' : 'entries'} · 🏆 **${g.winner_count}** winner${g.winner_count === 1 ? '' : 's'}`);
  if (g.required_role_id) lines.push(`🔒 Only <@&${g.required_role_id}> can enter`);
  if (g.host_id) lines.push(`🎁 Hosted by <@${g.host_id}>`);

  const embed = new EmbedBuilder()
    .setColor(active ? GOLD : g.status === 'ended' ? COLORS.brand : COLORS.muted)
    .setAuthor({ name: active ? '🎉 GIVEAWAY' : g.status === 'ended' ? '🎉 GIVEAWAY ENDED' : '🎉 GIVEAWAY CANCELLED' })
    .setTitle(truncate(g.prize, 256))
    .setDescription(truncate(lines.join('\n'), 4096))
    .setFooter(footer(`Giveaway #${g.id}${active ? ' · press the button to enter' : ''}`, client));
  const components = active ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gw:enter:${g.id}`).setLabel(`Enter (${entryCount})`).setEmoji('🎉').setStyle(ButtonStyle.Primary),
  )] : [];
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

export async function startGiveaway({ channelId, prize, description, winnerCount, requiredRoleId, endsAt, hostId, hostTag }) {
  const g = await createGiveaway({ channelId, prize, description, winnerCount, requiredRoleId, endsAt, hostId, hostTag });
  // Ping the giveaway notifications role (set on the Giveaways page), like Sapphire did
  const pingRole = (await getSettings()).giveaway_ping_role_id;
  try {
    const msg = await postTo(channelId, {
      ...giveawayMessage({ ...g, entry_count: 0 }),
      ...(pingRole ? { content: `<@&${pingRole}> 🎉 New giveaway!`, allowedMentions: { roles: [pingRole] } } : {}),
    });
    await updateGiveaway(g.id, { message_id: msg.id });
  } catch (err) {
    await updateGiveaway(g.id, { status: 'cancelled', ended_at: new Date() });
    throw err;
  }
  timers.set(`g:${g.id}`, new Date(g.ends_at).getTime());
  return getGiveaway(g.id);
}

export async function handleGiveawayButton(interaction) {
  const id = Number(interaction.customId.split(':')[2]);
  const g = await getGiveaway(id);
  if (!g || g.status !== 'active') return interaction.reply({ embeds: [notice('This giveaway has ended.', 'info')], flags: ephemeral });
  if (new Date(g.ends_at).getTime() <= Date.now()) return interaction.reply({ embeds: [notice('This giveaway is just ending. Good luck!', 'info')], flags: ephemeral });
  if (g.required_role_id && !interaction.member?.roles?.cache?.has(g.required_role_id)) {
    return interaction.reply({ embeds: [notice(`You need the <@&${g.required_role_id}> role to enter this giveaway.`, 'blocked')], flags: ephemeral, allowedMentions: { parse: [] } });
  }
  const r = await toggleGiveawayEntry(g.id, interaction.user.id);
  dirty.add(`g:${g.id}`);
  return interaction.reply({
    embeds: [r.entered
      ? notice(`You're in! 🎉 Good luck winning **${truncate(g.prize, 200)}**. Press the button again to leave.`, 'success')
      : notice('You left the giveaway.', 'info')],
    flags: ephemeral,
  });
}

/** Ends a giveaway now and announces winners. Returns { ok, error?, giveaway }. */
export async function endGiveaway(id) {
  const g = await getGiveaway(id);
  if (!g) return { ok: false, error: 'Giveaway not found.' };
  if (g.status !== 'active') return { ok: false, error: `This giveaway is already ${g.status}.` };
  timers.delete(`g:${g.id}`);
  const entrants = await giveawayEntrants(g.id);
  const winners = pickRandom(entrants, g.winner_count);
  const ended = await updateGiveaway(g.id, { status: 'ended', winner_ids: winners, ended_at: new Date() });
  await announce(ended, winners, false);
  return { ok: true, giveaway: ended };
}

/** Picks new winners (people who haven't won this one yet). */
export async function rerollGiveaway(id, count = 1) {
  const g = await getGiveaway(id);
  if (!g) return { ok: false, error: 'Giveaway not found.' };
  if (g.status !== 'ended') return { ok: false, error: 'You can only reroll a giveaway that has ended.' };
  const entrants = (await giveawayEntrants(g.id)).filter((u) => !g.winner_ids.includes(u));
  const winners = pickRandom(entrants, Math.max(1, Math.min(count, g.winner_count)));
  if (!winners.length) return { ok: false, error: 'There is nobody left to pick.' };
  const updated = await updateGiveaway(g.id, { winner_ids: [...g.winner_ids, ...winners] });
  await announce(updated, winners, true);
  return { ok: true, giveaway: updated, winners };
}

export async function cancelGiveaway(id) {
  const g = await getGiveaway(id);
  if (!g) return { ok: false, error: 'Giveaway not found.' };
  if (g.status !== 'active') return { ok: false, error: `This giveaway is already ${g.status}.` };
  timers.delete(`g:${g.id}`);
  const updated = await updateGiveaway(g.id, { status: 'cancelled', ended_at: new Date() });
  const msg = await fetchMessage(g.channel_id, g.message_id);
  await msg?.edit(giveawayMessage(updated)).catch(() => {});
  return { ok: true, giveaway: updated };
}

async function announce(g, winners, reroll) {
  const msg = await fetchMessage(g.channel_id, g.message_id);
  await msg?.edit(giveawayMessage(g)).catch((err) => console.warn('[giveaway] could not update message:', err.message));
  const channel = await client.channels.fetch(g.channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const text = winners.length
    ? `🎉 Congratulations ${winners.map((id) => `<@${id}>`).join(', ')}! You ${reroll ? 'were picked in the reroll and ' : ''}won **${g.prize}**!`
    : `😢 Nobody entered the giveaway for **${g.prize}**, so there is no winner.`;
  await channel.send({
    content: text,
    allowedMentions: { users: winners },
    ...(msg ? { reply: { messageReference: msg.id, failIfNotExists: false } } : {}),
  }).catch((err) => console.warn('[giveaway] could not announce:', err.message));
}

/* ---------- Polls ---------- */

const bar = (n, total, width = 10) => {
  const filled = total ? Math.round((n / total) * width) : 0;
  return `${'🟦'.repeat(filled)}${'⬛'.repeat(width - filled)}`;
};

export function pollMessage(poll, results) {
  const { counts, voters } = results;
  const total = counts.reduce((a, b) => a + b, 0);
  const active = poll.status === 'active';
  const top = Math.max(...counts);
  const lines = poll.options.map((opt, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const win = !active && total && counts[i] === top ? ' 🏆' : '';
    return `${NUMBERS[i]} **${truncate(opt, 100)}**${win}\n${bar(counts[i], total)} **${pct}%** · ${counts[i]} vote${counts[i] === 1 ? '' : 's'}`;
  });
  const info = [];
  info.push(`👥 **${voters}** ${voters === 1 ? 'person' : 'people'} voted`);
  if (poll.multi) info.push('☑️ You can pick more than one');
  if (active && poll.ends_at) info.push(`⏰ Ends <t:${unix(poll.ends_at)}:R>`);
  if (!active) info.push(`🔒 Closed <t:${unix(poll.ended_at || poll.ends_at || new Date())}:R>`);

  const embed = new EmbedBuilder()
    .setColor(active ? COLORS.sky : COLORS.muted)
    .setAuthor({ name: active ? '📊 POLL' : '📊 POLL CLOSED' })
    .setTitle(truncate(poll.question, 256))
    .setDescription(truncate(`${lines.join('\n\n')}\n\n${info.join(' · ')}`, 4096))
    .setFooter(footer(`Poll #${poll.id}${active ? ` · press a number to vote${poll.multi ? '' : ', press it again to take it back'}` : ''}`, client));
  const rows = [];
  if (active) {
    for (let start = 0; start < poll.options.length; start += 5) {
      rows.push(new ActionRowBuilder().addComponents(poll.options.slice(start, start + 5).map((opt, j) => {
        const i = start + j;
        return new ButtonBuilder().setCustomId(`poll:vote:${poll.id}:${i}`).setEmoji(NUMBERS[i])
          .setLabel(truncate(opt, 40)).setStyle(ButtonStyle.Secondary);
      })));
    }
  }
  return { embeds: [embed], components: rows };
}

export async function startPoll({ channelId, question, options, multi, endsAt, hostId, hostTag }) {
  const poll = await createPoll({ channelId, question, options, multi, endsAt, hostId, hostTag });
  try {
    const msg = await postTo(channelId, pollMessage(poll, { counts: options.map(() => 0), voters: 0 }));
    await updatePoll(poll.id, { message_id: msg.id });
  } catch (err) {
    await updatePoll(poll.id, { status: 'ended', ended_at: new Date() });
    throw err;
  }
  if (poll.ends_at) timers.set(`p:${poll.id}`, new Date(poll.ends_at).getTime());
  return getPoll(poll.id);
}

export async function handlePollButton(interaction) {
  const [, , pid, idx] = interaction.customId.split(':');
  const poll = await getPoll(Number(pid));
  const i = Number(idx);
  if (!poll || poll.status !== 'active') return interaction.reply({ embeds: [notice('This poll is closed.', 'info')], flags: ephemeral });
  if (!(i >= 0 && i < poll.options.length)) return interaction.reply({ embeds: [notice('That option no longer exists.', 'error')], flags: ephemeral });
  const r = await votePoll(poll, interaction.user.id, i);
  dirty.add(`p:${poll.id}`);
  return interaction.reply({
    embeds: [r.voted
      ? notice(`You voted for ${NUMBERS[i]} **${truncate(poll.options[i], 100)}**.`, 'success')
      : notice(`You took back your vote for ${NUMBERS[i]} **${truncate(poll.options[i], 100)}**.`, 'info')],
    flags: ephemeral,
  });
}

export async function endPoll(id) {
  const poll = await getPoll(id);
  if (!poll) return { ok: false, error: 'Poll not found.' };
  if (poll.status !== 'active') return { ok: false, error: 'This poll is already closed.' };
  timers.delete(`p:${poll.id}`);
  const ended = await updatePoll(poll.id, { status: 'ended', ended_at: new Date() });
  const msg = await fetchMessage(ended.channel_id, ended.message_id);
  await msg?.edit(pollMessage(ended, await pollResults(ended))).catch(() => {});
  return { ok: true, poll: ended };
}

/* ---------- Background loop ---------- */

async function refresh(key) {
  const [kind, id] = key.split(':');
  if (kind === 'g') {
    const g = await getGiveaway(Number(id));
    if (!g || g.status !== 'active') return;
    const msg = await fetchMessage(g.channel_id, g.message_id);
    await msg?.edit(giveawayMessage(g));
  } else {
    const p = await getPoll(Number(id));
    if (!p || p.status !== 'active') return;
    const msg = await fetchMessage(p.channel_id, p.message_id);
    await msg?.edit(pollMessage(p, await pollResults(p)));
  }
}

/** One pass: end anything that's due, then refresh messages that got new clicks. */
export async function tickCommunity(now = Date.now()) {
  for (const [key, at] of timers) {
    if (at > now) continue;
    const [kind, id] = key.split(':');
    timers.delete(key);
    dirty.delete(key);
    const r = kind === 'g' ? await endGiveaway(Number(id)) : await endPoll(Number(id));
    if (!r.ok) console.warn(`[community] could not end ${key}:`, r.error);
  }
  for (const key of [...dirty]) {
    dirty.delete(key);
    await refresh(key).catch((err) => console.warn(`[community] refresh ${key} failed:`, err.message));
  }
}

export async function loadCommunity() {
  for (const g of await listGiveaways({ status: 'active' })) timers.set(`g:${g.id}`, new Date(g.ends_at).getTime());
  for (const p of await listPolls()) if (p.status === 'active' && p.ends_at) timers.set(`p:${p.id}`, new Date(p.ends_at).getTime());
  console.log(`[community] tracking ${timers.size} giveaway/poll timer(s)`);
}

export function startCommunityLoop() {
  return setInterval(() => tickCommunity().catch((e) => console.warn('[community] tick failed:', e.message)), 5000);
}

export const _communityState = { timers, dirty };
