# App Bot

A Discord bot for staff applications and support tickets, with a web dashboard to set it all up.

**Applications**
- One panel with a dropdown: applicants pick a category (e.g. "Roblox Staff"), then a role (Admin, Developer…).
- The bot DMs them that role's questions one at a time, shows a review, and they press Submit.
- Finished applications land in your submissions channel with **Accept** / **Deny** buttons.
- Accepting can give a Discord role automatically. The applicant gets a DM either way.
- Built in: one application at a time, a cooldown after a denial, a 15-minute timeout in DMs, and a clear message when someone has DMs turned off.

**Tickets**
- An "Open a ticket" button in its own channel. The user types what they need, and the bot makes a private channel for them and your staff.
- Closing a ticket saves the full transcript, posts it to a log channel as a file, and DMs the user a copy.

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
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent** (needed for ticket transcripts).
3. **OAuth2** tab:
   - Copy the **Client ID** (`DISCORD_CLIENT_ID`) and **Client Secret** (`DISCORD_CLIENT_SECRET`).
   - Leave this tab open. You'll add a Redirect URL in step 3.
4. In Discord, turn on Developer Mode (User Settings > Advanced), then right-click your server > **Copy Server ID**. This is `GUILD_ID`.

### 2. Deploy on Railway

1. Sign in at [railway.com](https://railway.com) with your GitHub account.
2. **New Project > Deploy from GitHub repo** and pick this repo.
3. In the project, click **+ Create > Database > PostgreSQL**.
4. Open the bot service > **Variables** and add:

   | Variable | Value |
   | --- | --- |
   | `DISCORD_TOKEN` | from step 1 |
   | `DISCORD_CLIENT_ID` | from step 1 |
   | `DISCORD_CLIENT_SECRET` | from step 1 |
   | `GUILD_ID` | from step 1 |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway links it to the database) |
   | `SESSION_SECRET` | any long random string |
   | `PUBLIC_URL` | fill in after the next step |

5. Bot service > **Settings > Networking > Generate Domain**. Copy the address (like `https://app-bot-production.up.railway.app`) into `PUBLIC_URL`, with no slash at the end.

Railway redeploys when variables change. The logs should show `logged in as …`.

### 3. Connect the website login

Back in the Developer Portal > **OAuth2 > Redirects**, add:

```
https://YOUR-RAILWAY-ADDRESS/auth/callback
```

It must match `PUBLIC_URL` exactly, plus `/auth/callback`.

### 4. Add the bot to your server

Open your website, click **Add the bot to your server** under the sign-in button, and pick your server. The link asks for the permissions the bot needs: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Messages, Manage Channels and Manage Roles.

Then in **Server Settings > Roles**, drag the bot's role **above** any role it should give to accepted applicants. Discord won't let a bot give a role higher than its own.

### 5. Configure it on the dashboard

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
