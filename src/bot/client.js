import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: turn on in the Developer Portal (needed for ticket transcripts)
    GatewayIntentBits.DirectMessages,
  ],
  // Channel partial is required to receive DMs
  partials: [Partials.Channel, Partials.Message],
});

export async function getGuild() {
  return client.guilds.cache.get(config.guildId) || client.guilds.fetch(config.guildId);
}
