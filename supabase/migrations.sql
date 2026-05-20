-- =============================================================================
-- Collectium Slack MCP — Supabase Migrations
-- Run this once in your Supabase SQL editor or via the Supabase CLI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

create extension if not exists "uuid-ossp";


-- ---------------------------------------------------------------------------
-- Table: slack_tokens
-- One row per installed Slack workspace.
-- ---------------------------------------------------------------------------

create table if not exists public.slack_tokens (
    id              uuid primary key default uuid_generate_v4(),
    team_id         text not null unique,           -- Slack workspace ID  e.g. T012AB3C4
    team_name       text not null,                  -- Human-readable workspace name
    bot_user_id     text not null,                  -- Bot's own Slack user ID
    access_token    text not null,                  -- xoxb-... (treat as a secret)
    scope           text not null default '',       -- Comma-separated OAuth scopes granted
    installed_by    text,                           -- Slack user ID of the person who installed
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

comment on table  public.slack_tokens              is 'OAuth credentials for each installed Slack workspace.';
comment on column public.slack_tokens.team_id      is 'Slack workspace/team ID — globally unique.';
comment on column public.slack_tokens.access_token is 'Bot bearer token. Never expose to the frontend.';

-- Auto-update updated_at on every row change
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_slack_tokens_updated_at on public.slack_tokens;
create trigger trg_slack_tokens_updated_at
    before update on public.slack_tokens
    for each row execute function public.set_updated_at();

create index if not exists idx_slack_tokens_team_id
    on public.slack_tokens (team_id);


-- ---------------------------------------------------------------------------
-- Table: slack_messages
-- Synced Slack messages from all monitored channels.
-- Natural unique key: (team_id, channel_id, ts)
-- ---------------------------------------------------------------------------

create table if not exists public.slack_messages (
    id              uuid primary key default uuid_generate_v4(),

    -- Workspace / channel
    team_id         text not null,
    channel_id      text not null,
    channel_name    text,

    -- Author
    user_id         text,
    username        text,

    -- Content
    text            text not null default '',
    ts              text not null,                  -- Slack message timestamp (unique per channel)
    thread_ts       text,                           -- Parent thread ts — null if top-level message
    message_type    text not null default 'message',

    -- Metadata
    raw_payload     jsonb,                          -- Full Slack API response for debugging
    synced_at       timestamptz not null default now(),

    constraint uq_slack_messages_team_channel_ts
        unique (team_id, channel_id, ts)
);

comment on table  public.slack_messages            is 'Synced Slack messages from all monitored channels.';
comment on column public.slack_messages.ts         is 'Slack message timestamp — unique within a channel.';
comment on column public.slack_messages.thread_ts  is 'Non-null when this message is a thread reply.';
comment on column public.slack_messages.raw_payload is 'Raw JSON from Slack API kept for debugging.';

-- Core access pattern indexes
create index if not exists idx_slack_messages_team_channel
    on public.slack_messages (team_id, channel_id);

create index if not exists idx_slack_messages_ts
    on public.slack_messages (ts desc);

create index if not exists idx_slack_messages_thread
    on public.slack_messages (thread_ts)
    where thread_ts is not null;

create index if not exists idx_slack_messages_user
    on public.slack_messages (user_id)
    where user_id is not null;

-- Full-text search on message body
create index if not exists idx_slack_messages_text_fts
    on public.slack_messages
    using gin (to_tsvector('english', text));


-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.slack_tokens   enable row level security;
alter table public.slack_messages enable row level security;

-- Only service-role (our FastAPI backend) can touch tokens
create policy "service_role_only_tokens"
    on public.slack_tokens
    for all
    to service_role
    using (true)
    with check (true);

-- Service-role has full access to messages
create policy "service_role_full_messages"
    on public.slack_messages
    for all
    to service_role
    using (true)
    with check (true);

-- Uncomment to allow authenticated users to read their workspace's messages:
-- create policy "authenticated_read_own_messages"
--     on public.slack_messages
--     for select
--     to authenticated
--     using (
--         team_id = (
--             select raw_user_meta_data->>'slack_team_id'
--             from auth.users where id = auth.uid()
--         )
--     );


-- ---------------------------------------------------------------------------
-- Convenience view: latest message per channel
-- ---------------------------------------------------------------------------

create or replace view public.vw_channel_latest_message as
select distinct on (team_id, channel_id)
    team_id,
    channel_id,
    channel_name,
    text      as latest_text,
    user_id   as latest_user_id,
    ts        as latest_ts,
    synced_at as latest_synced_at
from public.slack_messages
order by team_id, channel_id, ts desc;

comment on view public.vw_channel_latest_message
    is 'Latest synced message per (team, channel) — for sidebar previews.';