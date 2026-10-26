// Welcome / leave / boost messages, auto roles on join, and the Verify panel.
// The config is kept in memory (loaded at start, replaced when saved on the dashboard),
// so member joins don't need to wake the database.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { randomInt } from 'node:crypto';
import { getWelcomeConfig, updateWelcomeConfig } from '../db.js';
import { bannerAttachment, cardAttachment, fetchAvatar } from './banner.js';
import { client, getGuild } from './client.js';
import {
  BRAND, COLORS, accountAge, ephemeral, footer, notice, truncate,
} from './ui.js';

let cfg = null;

export async function loadWelcomeConfig() {
  cfg = await getWelcomeConfig();
  return cfg;
}

/** Called by the dashboard after saving. */
export function setWelcomeConfig(next) {
  cfg = next;
}

async function current() {
  return cfg || loadWelcomeConfig();
}

/** Text placeholders people can use in their messages. */
export const PLACEHOLDERS = [
  ['{mention}', 'Pings the member'],
  ['{name}', 'Their display name'],
  ['{username}', 'Their username'],
  ['{server}', 'Server name'],
  ['{count}', 'Member count'],
  ['{boosts}', 'Number of boosts'],
  ['{rules}', 'Link to the rules channel'],
];

export function fillPlaceholders(text, { member, user, guild, rulesChannelId }) {
  const u = user || member?.user;
  const name = member?.displayName || u?.globalName || u?.username || 'someone';
  const map = {
    '{mention}': u ? `<@${u.id}>` : name,
    '{name}': name,
    '{username}': u?.username || name,
    '{server}': guild?.name || BRAND,
    '{count}': (guild?.memberCount ?? 0).toLocaleString('en-US'),
    '{boosts}': String(guild?.premiumSubscriptionCount ?? 0),
    '{rules}': rulesChannelId ? `<#${rulesChannelId}>` : 'the rules channel',
  };
  return String(text || '').replace(/\{(mention|name|username|server|count|boosts|rules)\}/g, (m) => map[m]);
}

const ordinalCount = (guild) => `Member #${(guild?.memberCount ?? 0).toLocaleString('en-US')}`;

/**
 * Builds a join / leave / boost message for a member.
 * kind: 'join' | 'leave' | 'boost'. Returns a message payload.
 */
export async function buildMemberMessage(kind, { member, user, guild }, c = cfg) {
  const u = user || member?.user;
  const ctx = { member, user: u, guild, rulesChannelId: c.rules_channel_id };
  const text = fillPlaceholders(c[`${kind}_message`], ctx);
  const name = member?.displayName || u?.globalName || u?.username || 'Member';
  const look = {
    join: { color: COLORS.brand, author: '👋 New member', heading: `Welcome to ${guild?.name || 'the server'}`, sub: ordinalCount(guild) },
    leave: { color: COLORS.muted, author: '🚪 Member left', heading: 'Goodbye', sub: `We now have ${(guild?.memberCount ?? 0).toLocaleString('en-US')} members` },
    boost: { color: 0xf47fff, author: '💎 New boost', heading: 'Thanks for boosting', sub: `${guild?.premiumSubscriptionCount ?? 0} boosts` },
  }[kind];

  const embed = new EmbedBuilder()
    .setColor(look.color)
    .setAuthor({ name: look.author })
    .setDescription(truncate(text || ' ', 4096))
    .setFooter(footer(kind === 'join' ? `Account age: ${u ? accountAge(u.id) : 'unknown'}` : null, client));

  const files = [];
  if (c[`${kind}_card`]) {
    const avatarUrl = u?.displayAvatarURL?.({ extension: 'png', size: 256 });
    const avatarPng = await fetchAvatar(avatarUrl);
    const card = cardAttachment({ kind, heading: look.heading, name, subtitle: look.sub, avatarPng }, `${kind}.png`);
    if (card) { embed.setImage(card.url); files.push(card.file); }
  } else if (u?.displayAvatarURL) {
    embed.setThumbnail(u.displayAvatarURL({ size: 128 }));
  }
  return {
    content: kind === 'leave' ? undefined : (u ? `<@${u.id}>` : undefined),
    embeds: [embed],
    files,
    allowedMentions: { users: kind === 'leave' || !u ? [] : [u.id] },
  };
}

async function sendTo(channelId, payload) {
  if (!channelId) return { ok: false, error: 'No channel picked.' };
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { ok: false, error: 'The bot cannot find that channel.' };
  try {
    await channel.send(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `The bot could not post there (${err.message}). Give it Send Messages, Embed Links and Attach Files.` };
  }
}

/* ---------- Events ---------- */

export async function handleMemberJoin(member) {
  const c = await current();
  const guild = member.guild;
  const roles = (c.auto_role_ids || []).filter((id) => guild.roles.cache.has(id));
  if (roles.length && !member.user.bot) {
    await member.roles.add(roles, 'Auto role on join').catch((err) => console.warn('[welcome] auto role failed (is the bot role above it?):', err.message));
  }
  if (member.user.bot) return;
  if (c.join_enabled && c.join_channel_id) {
    const r = await sendTo(c.join_channel_id, await buildMemberMessage('join', { member, guild }, c));
    if (!r.ok) console.warn('[welcome] join message:', r.error);
  }
  if (c.join_dm_enabled && c.join_dm_message) {
    const text = fillPlaceholders(c.join_dm_message, { member, guild, rulesChannelId: c.rules_channel_id });
    await member.send({ embeds: [new EmbedBuilder().setColor(COLORS.sky).setAuthor({ name: `👋 Welcome to ${guild.name}` }).setDescription(truncate(text, 4096)).setFooter(footer(null, client))] })
      .catch(() => {}); // DMs closed
  }
}

export async function handleMemberLeave(member) {
  const c = await current();
  if (!c.leave_enabled || !c.leave_channel_id || member.user?.bot) return;
  const r = await sendTo(c.leave_channel_id, await buildMemberMessage('leave', { member, user: member.user, guild: member.guild }, c));
  if (!r.ok) console.warn('[welcome] leave message:', r.error);
}

/** Fires on member updates; sends the boost message when someone starts boosting. */
export async function handleMemberUpdate(oldMember, newMember) {
  if (oldMember.premiumSince || !newMember.premiumSince) return;
  const c = await current();
  if (!c.boost_enabled || !c.boost_channel_id) return;
  const r = await sendTo(c.boost_channel_id, await buildMemberMessage('boost', { member: newMember, guild: newMember.guild }, c));
  if (!r.ok) console.warn('[welcome] boost message:', r.error);
}

/** "Send test" on the dashboard: posts the message for the person signed in. */
export async function sendTestMessage(kind, userId) {
  const c = await current();
  const channelId = c[`${kind}_channel_id`];
  const guild = await getGuild();
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, error: 'Could not find you in the server.' };
  return sendTo(channelId, await buildMemberMessage(kind, { member, guild }, c));
}

/* ---------- Verification ---------- */

// Codes shown in the pop-up, kept for 5 minutes: userId -> { code, expires }
const codes = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I look-alikes
const newCode = () => Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

export async function buildVerifyPanel(c = cfg) {
  const guild = await getGuild().catch(() => null);
  const banner = bannerAttachment('Verify', BRAND, 'verify.png');
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(c.verify_title || 'Verify to join', 256))
    .setDescription(truncate(fillPlaceholders(c.verify_message, { guild, rulesChannelId: c.rules_channel_id }), 4000))
    .addFields({ name: 'How it works', value: '1️⃣ Press **Verify** below\n2️⃣ Type the short code you see\n3️⃣ You\'re in! The rest of the server unlocks' })
    .setFooter(footer('Takes about 5 seconds', client));
  if (banner) embed.setImage(banner.url);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify:start').setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row], files: banner ? [banner.file] : [], attachments: [] };
}

/** Posts the Verify panel, or edits the one already posted. Throws an Error with a readable message. */
export async function publishVerifyPanel() {
  const c = await current();
  if (!c.verify_channel_id) throw new Error('Pick a verify channel first.');
  if (!c.verify_role_id) throw new Error('Pick the role to give when someone verifies first.');
  const channel = await client.channels.fetch(c.verify_channel_id).catch(() => null);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw new Error('The bot cannot find that channel. Check it still exists and the bot can see it.');
  const payload = await buildVerifyPanel(c);
  if (c.verify_panel_message_id) {
    const existing = await channel.messages.fetch(c.verify_panel_message_id).catch(() => null);
    if (existing) { await existing.edit(payload); return { updated: true }; }
  }
  try {
    const msg = await channel.send(payload);
    cfg = await updateWelcomeConfig({ verify_panel_message_id: msg.id });
    return { updated: false };
  } catch (err) {
    throw new Error(`The bot could not post in that channel (${err.message}). Give it View Channel, Send Messages, Embed Links and Attach Files there.`);
  }
}

export async function handleVerifyButton(interaction) {
  const c = await current();
  const member = interaction.member;
  if (!c.verify_role_id) return interaction.reply({ embeds: [notice('Verification is not set up yet. Please tell a staff member.', 'warn')], flags: ephemeral });
  if (member?.roles?.cache?.has(c.verify_role_id)) {
    return interaction.reply({ embeds: [notice('You are already verified. Enjoy the server!', 'success')], flags: ephemeral });
  }
  const minDays = Number(c.verify_min_account_days || 0);
  if (minDays > 0) {
    const created = Number((BigInt(interaction.user.id) >> 22n) + 1420070400000n);
    const ageDays = (Date.now() - created) / 86400000;
    if (ageDays < minDays) {
      return interaction.reply({ embeds: [notice(`Your Discord account needs to be at least **${minDays} day${minDays === 1 ? '' : 's'}** old to verify. Please try again later.`, 'blocked')], flags: ephemeral });
    }
  }
  const code = newCode();
  codes.set(interaction.user.id, { code, expires: Date.now() + 5 * 60 * 1000 });
  const modal = new ModalBuilder().setCustomId('verify:modal').setTitle('Quick check').addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('code').setLabel(`Type this code: ${code.split('').join(' ')}`)
        .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(5).setMaxLength(12).setPlaceholder('5 letters or numbers'),
    ),
  );
  return interaction.showModal(modal);
}

export async function handleVerifyModal(interaction) {
  const c = await current();
  const entry = codes.get(interaction.user.id);
  const typed = interaction.fields.getTextInputValue('code').replace(/\s+/g, '').toUpperCase();
  if (!entry || entry.expires < Date.now()) {
    codes.delete(interaction.user.id);
    return interaction.reply({ embeds: [notice('That code expired. Press **Verify** to get a new one.', 'warn')], flags: ephemeral });
  }
  if (typed !== entry.code) {
    codes.delete(interaction.user.id);
    return interaction.reply({ embeds: [notice("That code didn't match. Press **Verify** to try again.", 'error')], flags: ephemeral });
  }
  codes.delete(interaction.user.id);
  try {
    await interaction.member.roles.add(c.verify_role_id, 'Passed verification');
  } catch (err) {
    console.warn('[verify] could not give role:', err.message);
    return interaction.reply({ embeds: [notice('I could not give you the role. Please tell a staff member (the bot role must be above the Verified role).', 'error')], flags: ephemeral });
  }
  if (c.verify_log_channel_id) {
    sendTo(c.verify_log_channel_id, {
      embeds: [new EmbedBuilder().setColor(COLORS.accepted).setAuthor({ name: '✅ Member verified' })
        .setDescription(`<@${interaction.user.id}> (${interaction.user.tag || interaction.user.username})`)
        .addFields({ name: 'Account age', value: accountAge(interaction.user.id), inline: true })
        .setFooter(footer(null, client)).setTimestamp(new Date())],
      allowedMentions: { users: [] },
    }).catch(() => {});
  }
  return interaction.reply({ embeds: [notice("You're verified! 🎉 The rest of the server is unlocked. Have fun!", 'success')], flags: ephemeral });
}

// Drop old codes now and then so the map stays small
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
}, 10 * 60 * 1000).unref();

export const _welcomeState = { codes };
