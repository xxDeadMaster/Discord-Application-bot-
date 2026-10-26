// Role menus: a message with buttons; clicking one gives you that role, clicking again takes it away.
// Replaces reaction roles (Sapphire / Carl-bot). Buttons need no extra gateway events, so this costs nothing to run.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
} from 'discord.js';
import { getRoleMenu, setRoleMenuMessage } from '../db.js';
import { client, getGuild } from './client.js';
import {
  COLORS, ephemeral, footer, notice, optionEmoji, truncate,
} from './ui.js';

export const MAX_MENU_ITEMS = 10;

export function roleMenuMessage(menu, guild) {
  const items = (menu.items || []).slice(0, MAX_MENU_ITEMS);
  const lines = items.map((it) => `${it.emoji ? `${it.emoji} ` : ''}**${truncate(it.label || guild?.roles.cache.get(it.role_id)?.name || 'Role', 80)}** · <@&${it.role_id}>`);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(menu.title, 256))
    .setDescription(truncate([menu.description, lines.length ? lines.join('\n') : null, 'Press a button to get the role. Press it again to remove it.'].filter(Boolean).join('\n\n'), 4096))
    .setFooter(footer(null, client));
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(items.slice(i, i + 5).map((it) => {
      const b = new ButtonBuilder().setCustomId(`rm:${menu.id}:${it.role_id}`).setStyle(ButtonStyle.Secondary)
        .setLabel(truncate(it.label || guild?.roles.cache.get(it.role_id)?.name || 'Role', 80));
      if (it.emoji) b.setEmoji(optionEmoji(it.emoji));
      return b;
    })));
  }
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

/** Posts the menu, or edits the message already posted. Throws an Error with a readable message. */
export async function publishRoleMenu(menuId) {
  const menu = await getRoleMenu(menuId);
  if (!menu) throw new Error('That role menu no longer exists.');
  if (!menu.channel_id) throw new Error('Pick a channel for the menu first.');
  if (!(menu.items || []).length) throw new Error('Add at least one role button first.');
  const guild = await getGuild();
  const channel = await client.channels.fetch(menu.channel_id).catch(() => null);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw new Error('The bot cannot find that channel.');
  const payload = roleMenuMessage(menu, guild);
  if (menu.message_id) {
    const existing = await channel.messages.fetch(menu.message_id).catch(() => null);
    if (existing) { await existing.edit(payload); return { updated: true }; }
  }
  try {
    const msg = await channel.send(payload);
    await setRoleMenuMessage(menu.id, channel.id, msg.id);
    return { updated: false };
  } catch (err) {
    throw new Error(`The bot could not post there (${err.message}). Give it View Channel, Send Messages and Embed Links.`);
  }
}

/** Removes the posted message (used when a menu is deleted). */
export async function unpublishRoleMenu(menu) {
  if (!menu?.channel_id || !menu.message_id) return;
  const channel = await client.channels.fetch(menu.channel_id).catch(() => null);
  const msg = await channel?.messages?.fetch(menu.message_id).catch(() => null);
  try { await msg?.delete(); } catch { /* already gone, or no permission: the menu is still removed */ }
}

/** Button click: rm:<menuId>:<roleId> toggles that role for whoever clicked. */
export async function handleRoleMenuButton(interaction) {
  const [, menuId, roleId] = interaction.customId.split(':');
  const menu = await getRoleMenu(Number(menuId));
  if (!menu || !(menu.items || []).some((it) => it.role_id === roleId)) {
    return interaction.reply({ embeds: [notice('This button is no longer in use.', 'info')], flags: ephemeral });
  }
  const member = interaction.member;
  const role = interaction.guild?.roles.cache.get(roleId);
  if (!member || !role) return interaction.reply({ embeds: [notice('That role no longer exists. Please tell a staff member.', 'error')], flags: ephemeral });
  const has = member.roles.cache.has(roleId);
  try {
    if (has) await member.roles.remove(roleId, 'Role menu');
    else await member.roles.add(roleId, 'Role menu');
  } catch (err) {
    console.warn('[rolemenu] could not change role:', err.message);
    return interaction.reply({ embeds: [notice("I couldn't change that role. Please tell a staff member (the bot's role must be above it).", 'error')], flags: ephemeral });
  }
  return interaction.reply({
    embeds: [has ? notice(`Removed <@&${roleId}>. You won't get those pings anymore.`, 'info') : notice(`You now have <@&${roleId}>! 🎉`, 'success')],
    flags: ephemeral,
    allowedMentions: { parse: [] },
  });
}
