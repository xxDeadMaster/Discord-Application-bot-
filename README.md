# App Bot

A Discord bot for staff applications and support tickets, with a web dashboard to set it all up.

**Applications**
- One panel with a dropdown: applicants pick a category (e.g. "Roblox Staff"), then a role (Admin, Developer…).
- The bot DMs them that role's questions one at a time, shows a review, and they press Submit.
- Finished applications land in your submissions channel with **Accept** / **Deny** buttons.
- Accepting can give a Discord role automatically. The applicant gets a DM either way.
- Built in: one application at a time, a cooldown after a denial, a 15-minute timeout in DMs, and a clear message when someone has DMs turned off.
- **Blocked roles:** members with roles you pick in Settings (e.g. "BANNED FROM APPLYING") can't apply.
- **Schedules:** each application (category) can be always open, open between two dates, or open on set days and times each week. It disappears from the panel while closed and comes back by itself.
- **Staff voting:** Vote yes / Vote no buttons on every submission, with the tally on the card and the dashboard.
- **Interviews:** an Interview button makes a private temporary voice channel, DMs the applicant a join link, posts their answers in the channel chat, and deletes the channel when everyone leaves (or after 30 minutes if nobody joins).

**Tickets**
- Ticket types (Support, Report a Player, Partnership, Punishment Appeal, or your own), each with up to 5 questions, its own staff role and category.
- A private channel per ticket with **Claim** and **Close** buttons. Inactive tickets get a warning and then close on their own (hours set in Settings).
- After closing, the member gets a 1–5 star rating in their DMs. Ratings count toward whoever claimed the ticket.
- Closing a ticket saves the full transcript, posts it to a log channel as a file, and DMs the user a copy.

**Staff management**
- `/strike add|remove|list`: the bot gives the matching strike role (1–3), DMs the person, logs it, and pings managers at 3.
- `/loa request|end`: managers approve or deny in a channel or on the dashboard; the LOA role is added on the first day and removed after the last.
- Staff activity page: reviews, votes, interviews, tickets claimed and closed, average rating, strikes and LOA, for 7 days, 30 days or all time.

**Dashboard** (sign in with Discord, staff only)
- Add and edit categories, roles and questions. The panel in Discord updates by itself.
- Pick every channel and the staff role from dropdowns.
- Read, search and review submissions. Browse ticket history and download transcripts.
- Staff-role members can review and read. Only people with **Manage Server** can change settings.

---

## Setup

You'll do this once. It takes about 20 minutes.

### 1. Create the bot in Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it.
2. **Bot** tab:
   - Click **Reset Token** and copy the token. This is `DISCORD_TOKEN`. Treat it like a password: anyone with it controls your bot.
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent** (ticket transcripts) and **Server Members Intent** (staff lists, strikes and activity stats).
3. **OAuth2** tab:
   - Copy the **Client ID** (`DISCORD_CLIENT_ID`) and **Client Secret** (`DISCORD_CLIENT_SECRET`).
   - Leave this tab open. You'll add a Redirect URL in step 3.
4. In Discord, turn on Developer Mode (User Settings > Advanced), then right-click your server > **Copy Server ID**. This is `GUILD_ID`.

### 2. Create the database on Neon (free)

1. Sign in at [neon.com](https://neon.com) and create a project (any name, region **AWS US East**).
2. On the project dashboard click **Connect** and copy the connection string (starts with `postgresql://`). This is `DATABASE_URL`. It contains a password, so keep it private.

The free plan sleeps after a few idle minutes and wakes on the next request, so the first click after a quiet stretch can take a second.

### 3. Deploy on Fly.io (about $3.69/month)

`fly.toml` in this repo already sets the app name, region, machine size and the non-secret settings (`PUBLIC_URL`, `DISCORD_CLIENT_ID`, `GUILD_ID`). Change them there if you fork this for another server.

1. Sign in at [fly.io](https://fly.io) and add a payment method.
2. **Launch an App > from GitHub**, pick this repo. Fly reads `fly.toml` and the `Dockerfile`.
3. In the app's **Secrets**, add:

   | Secret | Value |
   | --- | --- |
   | `DISCORD_TOKEN` | Bot tab > Reset Token |
   | `DISCORD_CLIENT_SECRET` | OAuth2 tab > Client Secret |
   | `DATABASE_URL` | the Neon connection string |

4. Make sure exactly **one** machine is running (Machines tab). Two machines would mean two copies of the bot answering every click.

The logs should show `logged in as …`.

### 4. Connect the website login

Back in the Developer Portal > **OAuth2 > Redirects**, add:

```
https://xxdeadmaster-appbot.fly.dev/auth/callback
```

It must match `PUBLIC_URL` exactly, plus `/auth/callback`.

### 5. Add the bot to your server

Open your website, click **Add the bot to your server** under the sign-in button, and pick your server. The link asks for the permissions the bot needs: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Messages, Manage Channels and Manage Roles.

Then in **Server Settings > Roles**, drag the bot's role **above** any role it should give to accepted applicants. Discord won't let a bot give a role higher than its own.

### 6. Configure it on the dashboard

1. Sign in with Discord. At first only people with **Manage Server** can sign in.
2. **Settings**: pick the staff role, the applications channel, the submissions channel, the ticket channel, the ticket category and the ticket log channel. Save.
3. **Applications**: add a category (e.g. "Roblox Staff"), add roles to it, write each role's questions, and switch them on.
4. Back in **Settings > Panels**: press **Post or update** for both panels.

Done. Try applying yourself to see the whole flow.

---

## Running it on your own computer (optional, for testing)

You need Node.js 20+ and a Postgres database.

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev
```

Set `PUBLIC_URL=http://localhost:3000` and add `http://localhost:3000/auth/callback` as a second Redirect in the Developer Portal.

## Good to know

- Applications in progress live in memory. If the bot restarts while someone is answering, they need to pick their role again. Submitted applications are always saved.
- Discord dropdowns hold at most 25 options, so up to 25 categories, and 25 roles per category. Each role can have up to 20 questions.
- Attachment links in old transcripts come from Discord and can stop working over time. The text is always kept.
- Settings changes made on the dashboard take effect right away. Panel text changes need **Post or update** to show in Discord.

## Project layout

```
src/
  index.js            starts the database, bot and website
  config.js           reads environment variables
  db.js, schema.sql   Postgres tables and queries
  bot/
    applications.js   panel dropdowns, DM questions, review buttons
    tickets.js        open/close tickets, transcripts
    panels.js         builds and posts the two panels
  web/
    server.js, auth.js, routes.js   the dashboard
    views/, public/                 pages and styles
```
