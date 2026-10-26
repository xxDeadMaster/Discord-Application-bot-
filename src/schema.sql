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
