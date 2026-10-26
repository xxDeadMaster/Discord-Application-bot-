import { Events } from 'discord.js';
import { config } from '../config.js';
import {
  handleCategorySelect, handleDenyModal, handleDirectMessage, handleDmButton, handleReviewButton, handleRoleSelect,
} from './applications.js';
import { client } from './client.js';
import { syncProfile } from './profile.js';
import { handleInterviewChannelDelete, handleVoiceState, loadActiveInterviews } from './interviews.js';
import { startPanelScheduler } from './panels.js';
import { handleCommand, handleLoaButton, handleLoaModal, loadLoaSchedule, registerCommands } from './staff.js';
import {
  handleChannelDelete, handleClaimButton, handleCloseButton, handleCloseCancel, handleCloseConfirm, handleKeepOpen,
  handleOpenButton, handleOpenModal, handleRating, handleTypeSelect, loadOpenTickets, recordTicketMessage, startAutoClose,
} from './tickets.js';
import { ephemeral } from './ui.js';

function route(interaction) {
  if (interaction.isChatInputCommand()) return handleCommand(interaction);
  const id = interaction.customId;
  if (interaction.isStringSelectMenu()) {
    if (id === 'apply:category') return handleCategorySelect(interaction);
    if (id === 'apply:role') return handleRoleSelect(interaction);
    if (id === 'ticket:type') return handleTypeSelect(interaction);
  }
  if (interaction.isButton()) {
    if (id.startsWith('dm:')) return handleDmButton(interaction);
    if (id.startsWith('sub:')) return handleReviewButton(interaction);
    if (id === 'ticket:open') return handleOpenButton(interaction);
    if (id === 'ticket:close') return handleCloseButton(interaction);
    if (id === 'ticket:closeconfirm') return handleCloseConfirm(interaction);
    if (id === 'ticket:closecancel') return handleCloseCancel(interaction);
    if (id === 'ticket:claim') return handleClaimButton(interaction);
    if (id === 'ticket:keepopen') return handleKeepOpen(interaction);
    if (id.startsWith('trate:')) return handleRating(interaction);
    if (id.startsWith('loa:')) return handleLoaButton(interaction);
  }
  if (interaction.isModalSubmit()) {
    if (id.startsWith('sub:denymodal:')) return handleDenyModal(interaction);
    if (id.startsWith('ticket:openmodal')) return handleOpenModal(interaction);
    if (id === 'loa:modal') return handleLoaModal(interaction);
  }
  return null;
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.customId && !interaction.isChatInputCommand()) return;
  // Only serve our own server (DM buttons have no guild)
  if (interaction.guildId && interaction.guildId !== config.guildId) return;
  try {
    await route(interaction);
  } catch (err) {
    console.error(`[interaction ${interaction.customId || interaction.commandName}]`, err);
    const msg = { content: 'Something went wrong. Please try again, or tell a staff member.', flags: ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guildId) {
      if (!message.author.bot) await handleDirectMessage(message);
      return;
    }
    if (message.guildId === config.guildId) await recordTicketMessage(message);
  } catch (err) {
    console.error('[messageCreate]', err);
  }
});

client.on(Events.ChannelDelete, (channel) => {
  handleChannelDelete(channel).catch((err) => console.error('[channelDelete]', err));
  handleInterviewChannelDelete(channel).catch((err) => console.error('[channelDelete interview]', err));
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if ((newState.guild?.id || oldState.guild?.id) !== config.guildId) return;
  handleVoiceState(oldState, newState).catch((err) => console.error('[voiceState]', err));
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
  const guild = await c.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) console.warn(`[bot] not in server ${config.guildId} yet. Invite it with the link on the dashboard.`);
  syncProfile(c).catch((err) => console.warn('[profile] sync failed:', err.message));
  if (guild) {
    await registerCommands(guild);
    await guild.members.fetch().catch((err) => console.warn('[bot] could not load member list (turn on Server Members Intent):', err.message));
  }
  await loadOpenTickets().catch((err) => console.error('[tickets] load failed:', err));
  await loadActiveInterviews().catch((err) => console.error('[interview] load failed:', err));
  startPanelScheduler();
  startAutoClose();
  await loadLoaSchedule().catch((err) => console.error('[loa] load failed:', err));
});

client.on(Events.Error, (err) => console.error('[discord]', err));

export async function startBot() {
  await client.login(config.token);
  return client;
}
