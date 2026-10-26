import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: lists staff members for stats/strikes (turn on Server Members Intent)
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: turn on in the Developer Portal (needed for ticket transcripts)
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates, // interview voice channels: who joined and left
  ],
  // Channel partial is required to receive DMs
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

export async function getGuild() {
  return client.guilds.cache.get(config.guildId) || client.guilds.fetch(config.guildId);
}
