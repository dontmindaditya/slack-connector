-- ============================================================
-- Collectium Slack Connector — Database Schema
-- Migration: 001_slack_schema.sql
-- Run in Supabase SQL Editor or via supabase db push
-- ============================================================

-- ─── Extensions ──────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── slack_workspaces ────────────────────────────────────────────────────────
-- One row per Slack workspace installation.
-- bot_token should be encrypted at rest (AES-256-GCM via TOKEN_ENCRYPTION_KEY).

CREATE TABLE IF NOT EXISTS slack_workspaces (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slack_team_id         TEXT NOT NULL,           -- Slack's T01234ABC
  name                  TEXT NOT NULL,
  domain                TEXT NOT NULL DEFAULT '',
  icon_url              TEXT,
  bot_user_id           TEXT NOT NULL,           -- Slack's U01234ABC for the bot
  bot_token             TEXT NOT NULL,           -- xoxb- token (store encrypted)
  installed_by_user_id  TEXT NOT NULL,           -- Slack user ID of installer
  app_id                TEXT NOT NULL DEFAULT '',
  scope                 TEXT NOT NULL DEFAULT '',
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  installed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT slack_workspaces_team_id_unique UNIQUE (slack_team_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_workspaces_team_id
  ON slack_workspaces (slack_team_id);

CREATE INDEX IF NOT EXISTS idx_slack_workspaces_active
  ON slack_workspaces (is_active)
  WHERE is_active = TRUE;

-- ─── slack_channels ──────────────────────────────────────────────────────────
-- One row per channel per workspace.

CREATE TABLE IF NOT EXISTS slack_channels (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id      UUID NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  slack_channel_id  TEXT NOT NULL,               -- Slack's C01234ABC
  name              TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('public_channel', 'private_channel', 'mpim', 'im')),
  is_archived       BOOLEAN NOT NULL DEFAULT FALSE,
  is_member         BOOLEAN NOT NULL DEFAULT FALSE,
  topic             TEXT,
  purpose           TEXT,
  member_count      INTEGER,
  last_synced_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT slack_channels_workspace_channel_unique
    UNIQUE (workspace_id, slack_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_channels_workspace_id
  ON slack_channels (workspace_id);

CREATE INDEX IF NOT EXISTS idx_slack_channels_slack_id
  ON slack_channels (slack_channel_id);

CREATE INDEX IF NOT EXISTS idx_slack_channels_type
  ON slack_channels (workspace_id, type);

CREATE INDEX IF NOT EXISTS idx_slack_channels_member
  ON slack_channels (workspace_id, is_member)
  WHERE is_member = TRUE;

-- ─── slack_messages ──────────────────────────────────────────────────────────
-- One row per message per channel.
-- slack_ts is Slack's native timestamp string — unique per channel.

CREATE TABLE IF NOT EXISTS slack_messages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id      UUID NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  channel_id        UUID NOT NULL REFERENCES slack_channels (id) ON DELETE CASCADE,
  slack_ts          TEXT NOT NULL,               -- Slack's "1234567890.123456"
  slack_user_id     TEXT NOT NULL,               -- U01234ABC (not FK — denormalized)
  text              TEXT NOT NULL DEFAULT '',
  subtype           TEXT,                         -- bot_message, channel_join, etc.
  thread_ts         TEXT,                         -- Parent thread ts (if reply)
  reply_count       INTEGER NOT NULL DEFAULT 0,
  reactions         JSONB NOT NULL DEFAULT '[]',  -- [{name, count, users}]
  files             JSONB NOT NULL DEFAULT '[]',  -- [{id, name, mimetype, size, url}]
  blocks            JSONB NOT NULL DEFAULT '[]',  -- Block Kit blocks
  edited_at         TIMESTAMPTZ,
  slack_created_at  TIMESTAMPTZ NOT NULL,         -- Derived from slack_ts
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT slack_messages_unique
    UNIQUE (workspace_id, channel_id, slack_ts)
);

CREATE INDEX IF NOT EXISTS idx_slack_messages_workspace_channel
  ON slack_messages (workspace_id, channel_id);

CREATE INDEX IF NOT EXISTS idx_slack_messages_channel_created
  ON slack_messages (channel_id, slack_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_slack_messages_thread
  ON slack_messages (channel_id, thread_ts)
  WHERE thread_ts IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slack_messages_user
  ON slack_messages (workspace_id, slack_user_id);

CREATE INDEX IF NOT EXISTS idx_slack_messages_ts
  ON slack_messages (workspace_id, channel_id, slack_ts);

-- Full-text search index on message text
CREATE INDEX IF NOT EXISTS idx_slack_messages_fts
  ON slack_messages
  USING GIN (to_tsvector('english', text));

-- ─── slack_users ─────────────────────────────────────────────────────────────
-- One row per user per workspace.

CREATE TABLE IF NOT EXISTS slack_users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  slack_user_id   TEXT NOT NULL,               -- U01234ABC
  name            TEXT NOT NULL DEFAULT '',
  real_name       TEXT NOT NULL DEFAULT '',
  display_name    TEXT NOT NULL DEFAULT '',
  email           TEXT,
  avatar_url      TEXT,
  is_bot          BOOLEAN NOT NULL DEFAULT FALSE,
  is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
  timezone        TEXT,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT slack_users_workspace_user_unique
    UNIQUE (workspace_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_users_workspace_id
  ON slack_users (workspace_id);

CREATE INDEX IF NOT EXISTS idx_slack_users_slack_id
  ON slack_users (slack_user_id);

CREATE INDEX IF NOT EXISTS idx_slack_users_email
  ON slack_users (email)
  WHERE email IS NOT NULL;

-- ─── updated_at trigger ───────────────────────────────────────────────────────
-- Auto-update updated_at on every row modification.

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER set_updated_at_workspaces
  BEFORE UPDATE ON slack_workspaces
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE TRIGGER set_updated_at_channels
  BEFORE UPDATE ON slack_channels
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE TRIGGER set_updated_at_messages
  BEFORE UPDATE ON slack_messages
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE TRIGGER set_updated_at_users
  BEFORE UPDATE ON slack_users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();