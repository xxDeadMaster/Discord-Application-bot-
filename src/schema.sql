-- Runs on every start. Every statement is safe to re-run.

-- Website login sessions (format used by connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL PRIMARY KEY,
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Secrets the app generates for itself (e.g. the website's cookie signing key)
CREATE TABLE IF NOT EXISTS app_secrets (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  guild_id                 TEXT PRIMARY KEY,
  apply_channel_id         TEXT,
  submissions_channel_id   TEXT,
  ticket_channel_id        TEXT,
  ticket_category_id       TEXT,
  ticket_log_channel_id    TEXT,
  staff_role_id            TEXT,
  apply_panel_message_id   TEXT,
  ticket_panel_message_id  TEXT,
  apply_panel_title        TEXT NOT NULL DEFAULT 'Staff Applications',
  apply_panel_description  TEXT NOT NULL DEFAULT 'Pick what you are applying for below. I will DM you the questions for that role, so make sure your DMs are open for this server.',
  ticket_panel_title       TEXT NOT NULL DEFAULT 'Need help?',
  ticket_panel_description TEXT NOT NULL DEFAULT 'Click the button below to open a private ticket with staff.',
  apply_cooldown_days      INTEGER NOT NULL DEFAULT 7,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_categories (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_roles (
  id                     SERIAL PRIMARY KEY,
  category_id            INTEGER NOT NULL REFERENCES app_categories(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  discord_role_id        TEXT,
  submissions_channel_id TEXT,
  position               INTEGER NOT NULL DEFAULT 0,
  enabled                BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_questions (
  id         SERIAL PRIMARY KEY,
  role_id    INTEGER NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  prompt     TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS submissions (
  id                 SERIAL PRIMARY KEY,
  guild_id           TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  user_tag           TEXT NOT NULL,
  role_id            INTEGER REFERENCES app_roles(id) ON DELETE SET NULL,
  role_name          TEXT NOT NULL,
  category_name      TEXT NOT NULL,
  answers            JSONB NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  reviewed_by        TEXT,
  reviewed_by_tag    TEXT,
  reason             TEXT,
  review_channel_id  TEXT,
  review_message_id  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS submissions_user_idx ON submissions (guild_id, user_id);
CREATE INDEX IF NOT EXISTS submissions_status_idx ON submissions (guild_id, status);

CREATE TABLE IF NOT EXISTS tickets (
  id             SERIAL PRIMARY KEY,
  guild_id       TEXT NOT NULL,
  number         INTEGER NOT NULL,
  channel_id     TEXT,
  opener_id      TEXT NOT NULL,
  opener_tag     TEXT NOT NULL,
  topic          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open',
  closed_by      TEXT,
  closed_by_tag  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (guild_id, status);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id          SERIAL PRIMARY KEY,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL,
  author_tag  TEXT NOT NULL,
  is_bot      BOOLEAN NOT NULL DEFAULT false,
  content     TEXT NOT NULL DEFAULT '',
  attachments JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages (ticket_id, created_at);

-- ---------- Added later (safe to re-run) ----------

-- Roles that may not apply; interview voice channel category; timezone for schedules
ALTER TABLE settings ADD COLUMN IF NOT EXISTS blocked_role_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS interview_category_id TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';

-- Open/close schedule for a whole application (category): 'always' | 'dates' | 'weekly'
ALTER TABLE app_categories ADD COLUMN IF NOT EXISTS schedule_mode TEXT NOT NULL DEFAULT 'always';
ALTER TABLE app_categories ADD COLUMN IF NOT EXISTS open_at TIMESTAMPTZ;
ALTER TABLE app_categories ADD COLUMN IF NOT EXISTS close_at TIMESTAMPTZ;
ALTER TABLE app_categories ADD COLUMN IF NOT EXISTS weekly_days INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE app_categories ADD COLUMN IF NOT EXISTS weekly_start TEXT;
ALTER TABLE app_categories ADD COLUMN IF NOT EXISTS weekly_end TEXT;

-- Interviews: 'active' | 'done' | 'expired'
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS interview_status TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS interview_channel_id TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS interview_by_tag TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS interview_at TIMESTAMPTZ;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS interview_joined BOOLEAN NOT NULL DEFAULT false;

-- Staff votes on submissions: 'yes' | 'no'
CREATE TABLE IF NOT EXISTS submission_votes (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  user_tag      TEXT NOT NULL,
  vote          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, user_id)
);

-- Per-day weekly hours for applications: { "0": { "start": "12:00", "end": "20:00" }, ... } (0 = Sunday)
ALTER TABLE app_categories ADD COLUMN IF NOT EXISTS weekly_hours JSONB NOT NULL DEFAULT '{}';
UPDATE app_categories
   SET weekly_hours = (SELECT jsonb_object_agg(d::text, jsonb_build_object('start', weekly_start, 'end', weekly_end)) FROM unnest(weekly_days) AS d)
 WHERE weekly_hours = '{}'::jsonb AND cardinality(weekly_days) > 0 AND weekly_start IS NOT NULL AND weekly_end IS NOT NULL;

-- Ticket types (Support, Report a Player, ...), each with up to 5 questions
CREATE TABLE IF NOT EXISTS ticket_types (
  id            SERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  questions     TEXT[] NOT NULL DEFAULT '{}',
  staff_role_id TEXT,
  category_id   TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS type_id INTEGER REFERENCES ticket_types(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS type_name TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by_tag TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS welcome_message_id TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rating INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_close_hours INTEGER NOT NULL DEFAULT 48;

-- Who started an interview (for staff stats)
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS interview_by TEXT;

-- Staff management: who can issue strikes / approve LOA, strike roles (1..3), LOA role and channels
ALTER TABLE settings ADD COLUMN IF NOT EXISTS manager_role_id TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS strike_role_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS strike_log_channel_id TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS loa_role_id TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS loa_channel_id TEXT;

CREATE TABLE IF NOT EXISTS strikes (
  id             SERIAL PRIMARY KEY,
  guild_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  user_tag       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  issued_by      TEXT,
  issued_by_tag  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  revoked_by_tag TEXT
);
CREATE INDEX IF NOT EXISTS strikes_user_idx ON strikes (guild_id, user_id);

-- LOA requests: 'pending' | 'approved' | 'denied' | 'ended' | 'cancelled'
CREATE TABLE IF NOT EXISTS loa_requests (
  id                 SERIAL PRIMARY KEY,
  guild_id           TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  user_tag           TEXT NOT NULL,
  start_date         DATE NOT NULL,
  end_date           DATE NOT NULL,
  reason             TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending',
  role_applied       BOOLEAN NOT NULL DEFAULT false,
  reviewed_by        TEXT,
  reviewed_by_tag    TEXT,
  reviewed_at        TIMESTAMPTZ,
  message_channel_id TEXT,
  message_id         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loa_status_idx ON loa_requests (guild_id, status);

-- Emoji shown in dropdowns and titles (unicode or <:name:id>)
ALTER TABLE app_categories ADD COLUMN IF NOT EXISTS emoji TEXT;
ALTER TABLE app_roles ADD COLUMN IF NOT EXISTS emoji TEXT;
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS emoji TEXT;
-- Sensible defaults the first time (only where none is set yet)
UPDATE app_roles SET emoji = CASE
    WHEN name ILIKE '%admin%' THEN '🛡️' WHEN name ILIKE '%mod%' THEN '🔨' WHEN name ILIKE '%dev%' OR name ILIKE '%script%' THEN '💻'
    WHEN name ILIKE '%build%' THEN '🧱' WHEN name ILIKE '%anim%' THEN '🎬' WHEN name ILIKE '%ui%' OR name ILIKE '%design%' THEN '🎨'
    WHEN name ILIKE '%event%' THEN '🎉' WHEN name ILIKE '%support%' OR name ILIKE '%helper%' THEN '🤝' WHEN name ILIKE '%test%' THEN '🧪'
    ELSE '⭐' END
  WHERE emoji IS NULL;
UPDATE app_categories SET emoji = CASE WHEN name ILIKE '%roblox%' THEN '🎮' WHEN name ILIKE '%discord%' THEN '💬' WHEN name ILIKE '%content%' OR name ILIKE '%creator%' THEN '🎥' ELSE '📋' END
  WHERE emoji IS NULL;
UPDATE ticket_types SET emoji = CASE WHEN name ILIKE '%report%' THEN '🚨' WHEN name ILIKE '%partner%' THEN '🤝' WHEN name ILIKE '%appeal%' THEN '⚖️'
    WHEN name ILIKE '%bug%' THEN '🐞' ELSE '💬' END
  WHERE emoji IS NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS role_emoji TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS user_avatar TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS type_emoji TEXT;

/* ---------- Welcome, leave, boost + verification ---------- */
CREATE TABLE IF NOT EXISTS welcome_config (
  guild_id                TEXT PRIMARY KEY,
  join_enabled            BOOLEAN NOT NULL DEFAULT false,
  join_channel_id         TEXT,
  join_message            TEXT NOT NULL DEFAULT 'Hey {mention}, welcome to **{server}**! You are member **#{count}**.
Read the rules in {rules}, then press **Verify** to see the rest of the server.',
  join_card               BOOLEAN NOT NULL DEFAULT true,
  join_dm_enabled         BOOLEAN NOT NULL DEFAULT false,
  join_dm_message         TEXT NOT NULL DEFAULT 'Welcome to **{server}**, {name}! Read the rules and press Verify to get in. Have fun!',
  auto_role_ids           TEXT[] NOT NULL DEFAULT '{}',
  rules_channel_id        TEXT,
  leave_enabled           BOOLEAN NOT NULL DEFAULT false,
  leave_channel_id        TEXT,
  leave_message           TEXT NOT NULL DEFAULT '**{name}** left the server. We now have **{count}** members.',
  leave_card              BOOLEAN NOT NULL DEFAULT true,
  boost_enabled           BOOLEAN NOT NULL DEFAULT false,
  boost_channel_id        TEXT,
  boost_message           TEXT NOT NULL DEFAULT '{mention} just boosted **{server}**! 💎 Thank you! We now have **{boosts}** boosts.',
  boost_card              BOOLEAN NOT NULL DEFAULT true,
  verify_channel_id       TEXT,
  verify_role_id          TEXT,
  verify_title            TEXT NOT NULL DEFAULT 'Verify to join',
  verify_message          TEXT NOT NULL DEFAULT 'Welcome to **{server}**! Read the rules, then press **Verify** below and type the short code to unlock the server.',
  verify_min_account_days INTEGER NOT NULL DEFAULT 0,
  verify_log_channel_id   TEXT,
  verify_panel_message_id TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ---------- Giveaways ---------- */
CREATE TABLE IF NOT EXISTS giveaways (
  id               SERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  message_id       TEXT,
  prize            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  winner_count     INTEGER NOT NULL DEFAULT 1,
  required_role_id TEXT,
  ends_at          TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active', -- active | ended | cancelled
  winner_ids       TEXT[] NOT NULL DEFAULT '{}',
  host_id          TEXT,
  host_tag         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (giveaway_id, user_id)
);

/* ---------- Polls ---------- */
CREATE TABLE IF NOT EXISTS polls (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  message_id  TEXT,
  question    TEXT NOT NULL,
  options     TEXT[] NOT NULL,
  multi       BOOLEAN NOT NULL DEFAULT false,
  ends_at     TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'active', -- active | ended
  host_id     TEXT,
  host_tag    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id      INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id, option_index)
);
ALTER TABLE loa_requests ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

/* ---------- Server stat counters (channels renamed with live numbers) ---------- */
CREATE TABLE IF NOT EXISTS stat_counters (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,       -- members | humans | bots | channels | boosts | staff
  template    TEXT NOT NULL,       -- e.g. "all-members-{count}"
  position    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, channel_id)
);
