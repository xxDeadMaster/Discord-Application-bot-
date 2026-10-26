import 'dotenv/config';

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'GUILD_ID', 'DATABASE_URL', 'SESSION_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`);
  process.exit(1);
}

const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  guildId: process.env.GUILD_ID,
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL === 'true',
  sessionSecret: process.env.SESSION_SECRET,
  publicUrl,
  port: Number(process.env.PORT) || 3000,
  secureCookies: publicUrl.startsWith('https://'),

  // How long an applicant can go quiet in DMs before the application expires
  dmTimeoutMinutes: 15,
  // Longest answer accepted per question
  maxAnswerLength: 1000,
};
