import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { BOT, config } from '../config.js';

const ORBIT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers, // privileged: lists staff members for stats/strikes (turn on Server Members Intent)
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent, // privileged: turn on in the Developer Portal (needed for ticket transcripts)
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildVoiceStates, // interview voice channels: who joined and left
];

// Sentinel (security bot): joins, messages (spam trap / GIF blocker) and audit log entries (anti-nuke).
const SENTINEL_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers, // privileged: raid alarm counts joins
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent, // privileged: spam trap + GIF links
  GatewayIntentBits.GuildModeration, // audit log entries: who deleted channels, banned people, etc.
];

// The same client object is shared by every module, so in the Sentinel process this *is* Sentinel.
export const client = new Client({
  intents: BOT === 'sentinel' ? SENTINEL_INTENTS : ORBIT_INTENTS,
  // Channel partial is required to receive DMs
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

export async function getGuild() {
  return client.guilds.cache.get(config.guildId) || client.guilds.fetch(config.guildId);
}
