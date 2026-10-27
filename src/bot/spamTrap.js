// Spam trap: a channel nobody should post in. Spam bots post in every channel they can see,
// so anyone (who isn't staff) posting here is removed and their last hour of messages deleted.
// Costs nothing extra: it checks the channel ID of messages Orbit already receives.
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getSettings, updateSettings } from '../db.js';
import { client } from './client.js';
import { recordAutoCase } from './moderation.js';
import { COLORS, footer } from './ui.js';

// Kept in memory so normal messages never touch the database.
let trap = { channelId: null, messageId: null, caught: 0, staffRoleId: null, managerRoleId: null };
const recent = new Set(); // users being handled right now (spam bots send many messages at once)

export async function loadTrap() {
  const s = await getSettings();
  trap = { channelId: s.trap_channel_id, messageId: s.trap_message_id, caught: s.trap_caught || 0, staffRoleId: s.staff_role_id, managerRoleId: s.manager_role_id };
  return trap;
}

export const trapState = () => ({ ...trap });

export function trapMessage(caught = trap.caught) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.denied ?? 0xe5484d)
      .setTitle('🚫 Do not send messages in this channel')
      .setDescription([
        'This channel is a **trap for spam bots**. It is not used for anything else.',
        '',
        'Anyone who posts here is **removed from the server automatically** and their recent messages are deleted.',
        'If you are reading this, you are fine: just don\'t send anything.',
      ].join('\n'))
      .addFields({ name: 'Caught so far', value: `🪤 **${caught}**`, inline: true })
      .setFooter(footer('Spam protection', client))],
    allowedMentions: { parse: [] },
  };
}

/** Posts the warning message in the trap channel (or edits the one already there). */
export async function publishTrap() {
  await loadTrap();
  if (!trap.channelId) throw new Error('Pick a trap channel first.');
  const channel = await client.channels.fetch(trap.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('The bot cannot find that channel.');
  if (trap.messageId) {
    const existing = await channel.messages.fetch(trap.messageId).catch(() => null);
    if (existing) { await existing.edit(trapMessage()); return { updated: true }; }
  }
  const msg = await channel.send(trapMessage());
  await updateSettings({ trap_message_id: msg.id });
  trap.messageId = msg.id;
  return { updated: false };
}

function isExempt(member) {
  if (!member) return false;
  const p = member.permissions;
  if (p?.has?.(PermissionFlagsBits.Administrator) || p?.has?.(PermissionFlagsBits.ManageMessages) || p?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  return [trap.staffRoleId, trap.managerRoleId].some((r) => r && member.roles?.cache?.has(r));
}

/** Returns true if the message was in the trap channel (so other handlers can skip it). */
export async function handleTrapMessage(message) {
  if (!trap.channelId || message.channelId !== trap.channelId) return false;
  if (message.author?.bot || message.webhookId || message.system) return true;
  if (message.id === trap.messageId) return true;
  if (isExempt(message.member)) return true; // staff testing: leave it alone
  const user = message.author;
  if (recent.has(user.id)) { message.delete().catch(() => {}); return true; }
  recent.add(user.id);
  setTimeout(() => recent.delete(user.id), 60 * 1000);
  const guild = message.guild;
  const reason = 'Spam trap: posted in the spam trap channel';
  let action = 'kick';
  try {
    // "Soft ban": ban (which deletes their last hour of messages everywhere), then unban right away
    await guild.members.ban(user.id, { reason, deleteMessageSeconds: 3600 });
    await guild.members.unban(user.id, 'Spam trap: soft ban finished').catch(() => {});
  } catch {
    // No Ban Members permission: kick instead and just delete this message
    await message.delete().catch(() => {});
    try { await message.member?.kick(reason); } catch (err) {
      console.warn('[trap] could not remove', user.tag, err.message);
      return true;
    }
    action = 'kick';
  }
  trap.caught += 1;
  console.log(`[trap] removed ${user.tag || user.id} (${trap.caught} caught)`);
  await updateSettings({ trap_caught: trap.caught }).catch(() => {});
  await recordAutoCase({ user, action, reason: `${reason} (recent messages deleted)` }).catch((err) => console.warn('[trap] could not record case:', err.message));
  if (trap.messageId) {
    message.channel.messages.fetch(trap.messageId).then((m) => m.edit(trapMessage())).catch(() => {});
  }
  return true;
}
