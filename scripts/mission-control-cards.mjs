// Posts (or updates) the Mission Control info cards through a webhook.
//   MC_WEBHOOK=<webhook url> node scripts/mission-control-cards.mjs welcome|rules|bots [--edit <messageId>]
// The webhook posts in whatever channel it is set to in Discord (Server Settings → Integrations → Webhooks).
// To change a card later: edit the text below, then run with --edit and the message ID to update it in place.
const RAW = 'https://raw.githubusercontent.com/xxDeadMaster/Discord-Application-bot-/main/assets';
const PURPLE = 0x9b6dff;
const BLUE = 0x1f6feb;
const RED = 0xe5484d;
const INCIDENTS = '<#1566813720191963328>';

const CARDS = {
  welcome: [{
    color: PURPLE,
    image: { url: `${RAW}/mission-control-banner.png` },
    title: '🛰️ Welcome to Mission Control',
    description: [
      'Home base for **Orbit** and **Sentinel**, the bots that run 🎃 **BloxVerse Community**.',
      'Check here to see if the bots are up, what changed, and to get help.',
    ].join('\n'),
    fields: [
      { name: '🔵 Orbit', value: 'Staff applications, support tickets, staff tools, leveling and Roblox links.', inline: true },
      { name: '🔴 Sentinel', value: 'Security: anti-nuke, raid alarm, lockdowns, spam trap and GIF filter.', inline: true },
      {
        name: '🧭 Where to go',
        value: [
          '📣 **#announcements** · news about the bots',
          '📝 **#changelog** · every update, posted automatically',
          '🟢 **#bot-status** · when a bot goes online or offline',
          `🚨 ${INCIDENTS} · alerts if a bot stops answering`,
          '❓ **#help** · questions · 🐞 **#bug-reports** · 💡 **#suggestions**',
        ].join('\n'),
      },
    ],
    footer: { text: 'Mission Control · read #rules before posting' },
  }],

  rules: [{
    color: PURPLE,
    title: '📜 Rules',
    description: [
      '**1. Be respectful.** No harassment, hate or drama.',
      '**2. No spam or self-promo.** No ads, invite links or mass pings.',
      '**3. Use the right channel.** Bugs in #bug-reports, ideas in #suggestions, questions in #help.',
      "**4. Never share secrets.** Don't post tokens, passwords or webhook links. Staff will never ask for them.",
      "**5. Don't abuse the bots.** Found a way to break one? Report it in #bug-reports instead of using it.",
      "**6. Follow Discord's rules.** [Terms](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines).",
    ].join('\n\n'),
    footer: { text: 'Breaking the rules can get you removed. Thanks for keeping Mission Control clean.' },
  }],

  bots: [
    {
      color: BLUE,
      author: { name: 'Orbit', icon_url: `${RAW}/orbit-logo-512.png` },
      title: '🔵 Orbit · the all-in-one staff bot',
      thumbnail: { url: `${RAW}/orbit-logo-512.png` },
      description: [
        '**Staff applications** · forms in DMs, votes, interviews and accept/deny',
        '**Support tickets** · ticket types, claiming, transcripts and ratings',
        '**Staff tools** · strikes, leave (LOA), activity and a weekly staff report',
        '**Community** · leveling, giveaways, polls, role buttons and welcome messages',
        '**Roblox** · `/link` your account, `/roblox` to look someone up',
        '**Dashboard** · run it all from the web, no commands needed',
      ].join('\n'),
      image: { url: `${RAW}/orbit-banner.png` },
    },
    {
      color: RED,
      author: { name: 'Sentinel', icon_url: `${RAW}/sentinel-logo-512.png` },
      title: '🔴 Sentinel · always on watch',
      thumbnail: { url: `${RAW}/sentinel-logo-512.png` },
      description: [
        '**Anti-nuke** · stops mass channel, role and ban attacks and strips the attacker',
        '**Raid alarm** · spots join floods and can lock the server automatically',
        '**Lockdown** · `/lockdown on` locks every channel, `off` puts it all back',
        '**Spam trap** · catches spam bots in a hidden channel that renames itself daily',
        '**GIF filter** · keeps GIFs in the channels where they belong',
        '**Live dashboard** · joins, leaves, blocks and alerts as they happen',
      ].join('\n'),
      image: { url: `${RAW}/sentinel-banner.png` },
    },
  ],
};

const [card, flag, messageId] = process.argv.slice(2);
const url = (process.env.MC_WEBHOOK || '').trim();
if (!CARDS[card]) { console.error(`Pick a card: ${Object.keys(CARDS).join(', ')}`); process.exit(1); }
if (!/^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url)) { console.error('MC_WEBHOOK is missing or not a Discord webhook link.'); process.exit(1); }

const editing = flag === '--edit' && /^\d+$/.test(messageId || '');
const res = await fetch(editing ? `${url}/messages/${messageId}` : `${url}?wait=true`, {
  method: editing ? 'PATCH' : 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: 'Mission Control',
    avatar_url: `${RAW}/mission-control-logo-512.png`,
    embeds: CARDS[card],
    allowed_mentions: { parse: [] },
  }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Discord said ${res.status}: ${out.message || ''}`); process.exit(1); }
console.log(`${editing ? 'Updated' : 'Posted'} the ${card} card. Message ID: ${out.id}`);
