// Roblox account linking: /link <username> → put a short code in your Roblox bio → press "Check" → linked.
// Uses Roblox's free public API (no key). Links are stored per member; a "Roblox Linked" role is optional.
import crypto from 'node:crypto';
import {
  ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, EmbedBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { getSettings, query } from '../db.js';
import { client } from './client.js';
import { COLORS, ephemeral, footer, notice, truncate, unix } from './ui.js';

const T = ApplicationCommandOptionType;

export const robloxCommandData = [
  {
    name: 'link',
    description: 'Link your Roblox account',
    options: [{ type: T.String, name: 'username', description: 'Your Roblox username', required: true, min_length: 3, max_length: 20 }],
  },
  { name: 'unlink', description: 'Unlink your Roblox account' },
  {
    name: 'roblox',
    description: "See someone's linked Roblox account",
    options: [{ type: T.User, name: 'member', description: 'Who (you, if left empty)' }],
  },
];
export const ROBLOX_COMMANDS = robloxCommandData.map((c) => c.name);

/* ---------- Roblox API ---------- */

let fetchImpl = (...a) => fetch(...a);
export function _setFetch(fn) { fetchImpl = fn; }

async function robloxJson(url, init = {}) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  if (res.status === 429) throw new Error('Roblox is busy right now (rate limited). Try again in a minute.');
  if (!res.ok) throw new Error(`Roblox answered ${res.status}`);
  return res.json();
}

/** { id, name, displayName } or null when the username doesn't exist. */
export async function findRobloxUser(username) {
  const data = await robloxJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  const u = data?.data?.[0];
  return u ? { id: String(u.id), name: u.name, displayName: u.displayName || u.name } : null;
}

/** Full profile: { id, name, displayName, description, created }. */
export async function getRobloxProfile(id) {
  const u = await robloxJson(`https://users.roblox.com/v1/users/${encodeURIComponent(id)}`);
  return { id: String(u.id), name: u.name, displayName: u.displayName || u.name, description: u.description || '', created: u.created ? new Date(u.created) : null };
}

export async function getHeadshot(id) {
  try {
    const d = await robloxJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(id)}&size=150x150&format=Png&isCircular=false`);
    return d?.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

export const profileUrl = (id) => `https://www.roblox.com/users/${id}/profile`;

/* ---------- Codes ---------- */

// Plain words only, so Roblox's chat filter doesn't hashtag the code in the bio
const WORDS = ['apple', 'rocket', 'tiger', 'planet', 'pizza', 'castle', 'dragon', 'river', 'galaxy', 'pencil', 'jungle', 'robot',
  'thunder', 'cookie', 'island', 'meteor', 'garden', 'panda', 'comet', 'violet', 'marble', 'falcon', 'orange', 'winter'];
const pending = new Map(); // discord user id -> { code, robloxId, name, displayName, expires }
const CODE_MINUTES = 15;

function newCode() {
  const pickWord = () => WORDS[crypto.randomInt(WORDS.length)];
  return `orbit ${pickWord()} ${pickWord()} ${pickWord()}`;
}

/* ---------- Storage ---------- */

export async function getLink(userId) {
  const { rows } = await query('SELECT * FROM roblox_links WHERE guild_id = $1 AND user_id = $2', [config.guildId, userId]);
  return rows[0] || null;
}

export async function getLinkByRoblox(robloxId) {
  const { rows } = await query('SELECT * FROM roblox_links WHERE guild_id = $1 AND roblox_id = $2', [config.guildId, robloxId]);
  return rows[0] || null;
}

export async function listLinks({ search = null, limit = 200 } = {}) {
  const params = [config.guildId];
  let where = '';
  if (search) { params.push(`%${search.toLowerCase()}%`); where = 'AND (lower(user_tag) LIKE $2 OR lower(roblox_name) LIKE $2 OR lower(display_name) LIKE $2 OR user_id = $3 OR roblox_id = $3)'; params.push(search); }
  const { rows } = await query(`SELECT * FROM roblox_links WHERE guild_id = $1 ${where} ORDER BY linked_at DESC LIMIT ${Number(limit) | 0}`, params);
  return rows;
}

export async function countLinks() {
  const { rows } = await query('SELECT count(*)::int AS n FROM roblox_links WHERE guild_id = $1', [config.guildId]);
  return rows[0].n;
}

async function saveLink({ userId, userTag, robloxId, name, displayName }) {
  await query(
    `INSERT INTO roblox_links (guild_id, user_id, user_tag, roblox_id, roblox_name, display_name, linked_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (guild_id, user_id) DO UPDATE SET user_tag = EXCLUDED.user_tag, roblox_id = EXCLUDED.roblox_id,
       roblox_name = EXCLUDED.roblox_name, display_name = EXCLUDED.display_name, linked_at = now()`,
    [config.guildId, userId, userTag, robloxId, name, displayName],
  );
}

export async function removeLink(userId) {
  const { rowCount } = await query('DELETE FROM roblox_links WHERE guild_id = $1 AND user_id = $2', [config.guildId, userId]);
  return rowCount > 0;
}

/** Gives or takes the "Roblox Linked" role. Returns a short note when it can't. */
export async function syncLinkedRole(member, linked, settings) {
  const roleId = (settings || await getSettings()).roblox_role_id;
  if (!roleId || !member) return '';
  try {
    if (linked && !member.roles.cache.has(roleId)) await member.roles.add(roleId, 'Linked Roblox account');
    if (!linked && member.roles.cache.has(roleId)) await member.roles.remove(roleId, 'Unlinked Roblox account');
    return '';
  } catch {
    return " (I couldn't change your role. Staff: Orbit's role must be above the Roblox Linked role.)";
  }
}

/* ---------- Cards ---------- */

export async function linkCard(link, { title = null } = {}) {
  const img = await getHeadshot(link.roblox_id);
  const embed = new EmbedBuilder().setColor(COLORS.brand)
    .setAuthor({ name: title || '🔗 Roblox account' })
    .setTitle(truncate(link.display_name && link.display_name !== link.roblox_name ? `${link.display_name} (@${link.roblox_name})` : `@${link.roblox_name}`, 256))
    .setURL(profileUrl(link.roblox_id))
    .addFields(
      { name: 'Discord', value: `<@${link.user_id}>`, inline: true },
      { name: 'Linked', value: `<t:${unix(link.linked_at)}:R>`, inline: true },
    )
    .setFooter(footer(`Roblox ID ${link.roblox_id}`, client));
  if (img) embed.setThumbnail(img);
  return embed;
}

/* ---------- Commands ---------- */

const say = (text, kind = 'info') => ({ content: '', embeds: [notice(text, kind)] });

export async function handleRobloxCommand(interaction) {
  const name = interaction.commandName;

  if (name === 'roblox') {
    const who = interaction.options.getUser('member') || interaction.user;
    const link = await getLink(who.id);
    if (!link) {
      return interaction.reply({ ...say(who.id === interaction.user.id ? "You haven't linked a Roblox account yet. Use `/link` with your Roblox username." : `${who} hasn't linked a Roblox account.`, 'info'), flags: ephemeral, allowedMentions: { users: [] } });
    }
    await interaction.deferReply({ flags: ephemeral });
    return interaction.editReply({ content: '', embeds: [await linkCard(link)], allowedMentions: { users: [] } });
  }

  if (name === 'unlink') {
    const removed = await removeLink(interaction.user.id);
    pending.delete(interaction.user.id);
    const note = removed ? await syncLinkedRole(interaction.member, false) : '';
    return interaction.reply({ ...say(removed ? `Your Roblox account is unlinked.${note}` : "You don't have a linked Roblox account.", removed ? 'success' : 'info'), flags: ephemeral });
  }

  // /link <username>
  const username = String(interaction.options.getString('username') || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return interaction.reply({ ...say('That doesn\'t look like a Roblox username (3–20 letters, numbers or _).', 'error'), flags: ephemeral });
  }
  await interaction.deferReply({ flags: ephemeral });
  let user;
  try { user = await findRobloxUser(username); } catch (err) { return interaction.editReply(say(`Couldn't reach Roblox: ${err.message}`, 'error')); }
  if (!user) return interaction.editReply(say(`No Roblox account is called **${username}**. Check the spelling.`, 'error'));
  const taken = await getLinkByRoblox(user.id);
  if (taken && taken.user_id !== interaction.user.id) {
    return interaction.editReply(say(`**@${user.name}** is already linked to another member. If it's yours, open a ticket and staff will sort it out.`, 'blocked'));
  }
  const code = newCode();
  pending.set(interaction.user.id, { code, robloxId: user.id, name: user.name, displayName: user.displayName, expires: Date.now() + CODE_MINUTES * 60_000 });
  const embed = new EmbedBuilder().setColor(COLORS.brand).setAuthor({ name: '🔗 Link your Roblox account' })
    .setTitle(truncate(`${user.displayName} (@${user.name})`, 256)).setURL(profileUrl(user.id))
    .setDescription([
      'To prove this account is yours:',
      `**1.** Open your Roblox profile and edit your **About** (bio).`,
      `**2.** Add this code anywhere in it:\n\`\`\`${code}\`\`\``,
      '**3.** Save, then press **Check my bio** below.',
      '',
      `The code works for ${CODE_MINUTES} minutes. You can remove it from your bio after you're linked.`,
    ].join('\n'))
    .setFooter(footer('Only you can see this', client));
  const img = await getHeadshot(user.id);
  if (img) embed.setThumbnail(img);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('roblox:check').setLabel('Check my bio').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setLabel('Open profile').setStyle(ButtonStyle.Link).setURL(profileUrl(user.id)),
  );
  return interaction.editReply({ content: '', embeds: [embed], components: [row] });
}

/** "Check my bio" button. */
export async function handleRobloxButton(interaction) {
  const p = pending.get(interaction.user.id);
  if (!p || p.expires < Date.now()) {
    pending.delete(interaction.user.id);
    return interaction.reply({ ...say('That code expired. Run `/link` again to get a new one.', 'warn'), flags: ephemeral });
  }
  await interaction.deferReply({ flags: ephemeral });
  let profile;
  try { profile = await getRobloxProfile(p.robloxId); } catch (err) { return interaction.editReply(say(`Couldn't reach Roblox: ${err.message}`, 'error')); }
  const bio = profile.description.toLowerCase().replace(/\s+/g, ' ');
  if (!bio.includes(p.code)) {
    return interaction.editReply(say(`I couldn't find \`${p.code}\` in the bio of **@${profile.name}** yet. Make sure you saved it, wait a few seconds, then press **Check my bio** again.`, 'warn'));
  }
  const taken = await getLinkByRoblox(p.robloxId);
  if (taken && taken.user_id !== interaction.user.id) {
    pending.delete(interaction.user.id);
    return interaction.editReply(say(`**@${profile.name}** is already linked to another member. Open a ticket if it's yours.`, 'blocked'));
  }
  await saveLink({ userId: interaction.user.id, userTag: interaction.user.tag || interaction.user.username, robloxId: p.robloxId, name: profile.name, displayName: profile.displayName });
  pending.delete(interaction.user.id);
  const note = await syncLinkedRole(interaction.member, true);
  const link = await getLink(interaction.user.id);
  return interaction.editReply({ content: '', embeds: [notice(`You're linked to **@${profile.name}**! You can take the code out of your bio now.${note}`, 'success'), await linkCard(link)], components: [] });
}

/** Re-joining members get their Roblox Linked role back. */
export async function handleRobloxJoin(member) {
  if (member.user?.bot) return;
  const link = await getLink(member.id);
  if (link) await syncLinkedRole(member, true);
}


export const _robloxState = { pending };
