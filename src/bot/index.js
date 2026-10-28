import { Events, GatewayIntentBits, Routes } from 'discord.js';
import { config } from '../config.js';
import {
  handleCategorySelect, handleDenyModal, handleDirectMessage, handleDmButton, handleReviewButton, handleRoleSelect,
} from './applications.js';
import { client } from './client.js';
import { syncProfile } from './profile.js';
import { handleInterviewChannelDelete, handleVoiceState, loadActiveInterviews } from './interviews.js';
import { startPanelScheduler } from './panels.js';
import { handleTrapMessage, loadTrap } from './spamTrap.js';
import { handlePresenceUpdate, loadPresence, setPresenceTracking, startPresenceSaver } from './presence.js';
import { ROBLOX_COMMANDS, handleRobloxButton, handleRobloxCommand, handleRobloxJoin } from './roblox.js';
import { handleAutoAnswer, loadAutoAnswers } from './autoAnswers.js';
import { startStaffReport } from './staffReport.js';
import { handleCommand, handleLoaButton, handleLoaModal, loadLoaSchedule, registerCommands } from './staff.js';
import {
  handleChannelDelete, handleClaimButton, handleCloseButton, handleCloseCancel, handleCloseConfirm, handleKeepOpen,
  handleOpenButton, handleOpenModal, handleRating, handleTypeSelect, loadOpenTickets, recordTicketMessage, startAutoClose,
} from './tickets.js';
import { ephemeral } from './ui.js';
import {
  handleMemberJoin, handleMemberLeave, handleMemberUpdate, handleVerifyButton, handleVerifyModal, loadWelcomeConfig,
} from './welcome.js';
import { countMemberChange, loadCounters, startCounters, startSnapshots } from './counters.js';
import { handleRoleMenuButton } from './roleMenus.js';
import { MOD_COMMANDS, handleModCommand } from './moderation.js';
import {
  handleLevelBoost, handleLevelMessage, loadLevels, startLeveling,
} from './levels.js';
import { handleCommunityAutocomplete, handleCommunityCommand } from './communityCommands.js';
import { handleGiveawayButton, handlePollButton, loadCommunity, startCommunityLoop } from './giveaways.js';

function route(interaction) {
  if (interaction.isAutocomplete()) return handleCommunityAutocomplete(interaction);
  if (interaction.isChatInputCommand()) {
    if (MOD_COMMANDS.includes(interaction.commandName)) return handleModCommand(interaction);
    if (ROBLOX_COMMANDS.includes(interaction.commandName)) return handleRobloxCommand(interaction);
    if (['giveaway', 'poll', 'rank', 'leaderboard', 'xp'].includes(interaction.commandName)) return handleCommunityCommand(interaction);
    return handleCommand(interaction);
  }
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
    if (id === 'verify:start') return handleVerifyButton(interaction);
    if (id.startsWith('gw:enter:')) return handleGiveawayButton(interaction);
    if (id.startsWith('poll:vote:')) return handlePollButton(interaction);
    if (id.startsWith('rm:')) return handleRoleMenuButton(interaction);
    if (id === 'roblox:check') return handleRobloxButton(interaction);
    if (id.startsWith('apply:open:')) {
      // A category's own panel: same flow as picking it from the main panel's menu
      interaction.values = [id.split(':')[2]];
      return handleCategorySelect(interaction);
    }
  }
  if (interaction.isModalSubmit()) {
    if (id.startsWith('sub:denymodal:')) return handleDenyModal(interaction);
    if (id.startsWith('ticket:openmodal')) return handleOpenModal(interaction);
    if (id === 'loa:modal') return handleLoaModal(interaction);
    if (id === 'verify:modal') return handleVerifyModal(interaction);
  }
  return null;
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.customId && !interaction.isChatInputCommand() && !interaction.isAutocomplete()) return;
  // Only serve our own server (DM buttons have no guild)
  if (interaction.guildId && interaction.guildId !== config.guildId) return;
  try {
    await route(interaction);
  } catch (err) {
    console.error(`[interaction ${interaction.customId || interaction.commandName}]`, err);
    if (interaction.isAutocomplete()) return;
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
    if (message.guildId === config.guildId) {
      if (await handleTrapMessage(message)) return;
      await recordTicketMessage(message);
      await handleLevelMessage(message);
      await handleAutoAnswer(message).catch((err) => console.warn('[auto-answer]', err.message));
    }
  } catch (err) {
    console.error('[messageCreate]', err);
  }
});

client.on(Events.ChannelDelete, (channel) => {
  handleChannelDelete(channel).catch((err) => console.error('[channelDelete]', err));
  handleInterviewChannelDelete(channel).catch((err) => console.error('[channelDelete interview]', err));
});

/** Orbit is private to BloxVerse: leave any other server it gets added to. */
export async function leaveOtherServers() {
  for (const g of client.guilds.cache.values()) {
    if (g.id === config.guildId) continue;
    console.warn(`[bot] leaving server that isn't BloxVerse: ${g.name} (${g.id})`);
    await g.leave().catch((err) => console.warn('[bot] could not leave server:', err.message));
  }
}

client.on(Events.GuildCreate, (guild) => {
  if (guild.id === config.guildId) return;
  console.warn(`[bot] added to another server: ${guild.name} (${guild.id}), leaving`);
  guild.leave().catch((err) => console.warn('[bot] could not leave server:', err.message));
});

client.on(Events.GuildMemberAdd, (member) => {
  if (member.guild.id !== config.guildId) return;
  countMemberChange('join');
  handleMemberJoin(member).catch((err) => console.error('[memberAdd]', err));
  handleRobloxJoin(member).catch((err) => console.warn('[roblox join]', err.message));
});

client.on(Events.GuildMemberRemove, (member) => {
  if (member.guild.id !== config.guildId) return;
  countMemberChange('leave');
  handleMemberLeave(member).catch((err) => console.error('[memberRemove]', err));
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  if (newMember.guild.id !== config.guildId) return;
  handleMemberUpdate(oldMember, newMember).catch((err) => console.error('[memberUpdate]', err));
  handleLevelBoost(oldMember, newMember).catch((err) => console.error('[levels boost]', err));
});

client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
  handlePresenceUpdate(oldPresence, newPresence).catch((err) => console.warn('[presence]', err.message));
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
  await leaveOtherServers();
  if (guild) {
    await registerCommands(guild);
    await guild.members.fetch().catch((err) => console.warn('[bot] could not load member list (turn on Server Members Intent):', err.message));
  }
  await loadOpenTickets().catch((err) => console.error('[tickets] load failed:', err));
  await loadActiveInterviews().catch((err) => console.error('[interview] load failed:', err));
  startPanelScheduler();
  startAutoClose();
  await loadLoaSchedule().catch((err) => console.error('[loa] load failed:', err));
  await loadWelcomeConfig().catch((err) => console.error('[welcome] load failed:', err));
  await loadCommunity().catch((err) => console.error('[community] load failed:', err));
  startCommunityLoop();
  await loadCounters().catch((err) => console.error('[counters] load failed:', err));
  startCounters();
  startSnapshots();
  await loadLevels().catch((err) => console.error('[levels] load failed:', err));
  startLeveling();
  await loadTrap().catch((err) => console.error('[trap] load failed:', err));
  await loadPresence().catch((err) => console.error('[presence] load failed:', err));
  startPresenceSaver();
  await loadAutoAnswers().catch((err) => console.error('[auto-answers] load failed:', err));
  startStaffReport();
});

client.on(Events.Error, (err) => console.error('[discord]', err));

// Presence Intent flags on the application (enabled, or enabled for bots under 100 servers)
const PRESENCE_FLAGS = (1 << 12) | (1 << 13);

/** Asks for online/offline updates only if Presence Intent is on, so the bot never fails to log in over it. */
async function enablePresenceIfAllowed() {
  try {
    client.rest.setToken(config.token);
    const app = await client.rest.get(Routes.currentApplication());
    if (!(app.flags & PRESENCE_FLAGS)) {
      console.warn('[presence] Presence Intent is off in the Developer Portal: staff online status is hidden');
      return;
    }
    client.options.intents = client.options.intents.add(GatewayIntentBits.GuildPresences);
    setPresenceTracking(true);
  } catch (err) {
    console.warn('[presence] could not check Presence Intent, leaving it off:', err.message);
  }
}

export async function startBot() {
  await enablePresenceIfAllowed();
  await client.login(config.token);
  return client;
}
