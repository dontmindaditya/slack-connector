/**
 * Slack domain types used across services, handlers, and sync layers.
 * These mirror Slack API shapes but are normalized for internal use.
 */

// ─── Workspace ───────────────────────────────────────────────────────────────

export interface SlackWorkspace {
  id: string;           // Slack team_id e.g. "T01234ABC"
  name: string;
  domain: string;
  iconUrl?: string;
  botUserId: string;    // The bot user ID for this installation
  botToken: string;     // xoxb- token (encrypted at rest in DB)
  installedByUserId: string;
  installedAt: Date;
}

// ─── Channel ─────────────────────────────────────────────────────────────────

export type SlackChannelType = 'public_channel' | 'private_channel' | 'mpim' | 'im';

export interface SlackChannel {
  id: string;             // C01234ABC
  workspaceId: string;    // FK to workspace
  name: string;
  type: SlackChannelType;
  isArchived: boolean;
  isMember: boolean;
  topic?: string;
  purpose?: string;
  memberCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── User ─────────────────────────────────────────────────────────────────────

export interface SlackUser {
  id: string;             // U01234ABC
  workspaceId: string;
  name: string;
  realName: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  isBot: boolean;
  isAdmin: boolean;
  isDeleted: boolean;
  timezone?: string;
  updatedAt: Date;
}

// ─── Message ─────────────────────────────────────────────────────────────────

export type SlackMessageSubtype =
  | 'bot_message'
  | 'channel_join'
  | 'channel_leave'
  | 'file_share'
  | 'thread_broadcast'
  | undefined;

export interface SlackMessage {
  ts: string;             // Slack timestamp — unique per channel, used as ID
  workspaceId: string;
  channelId: string;
  userId: string;
  text: string;
  subtype?: SlackMessageSubtype;
  threadTs?: string;      // Parent thread timestamp (if reply)
  replyCount?: number;
  reactions?: SlackReaction[];
  files?: SlackFile[];
  blocks?: unknown[];     // Block Kit blocks (raw JSON)
  editedAt?: Date;
  createdAt: Date;        // Derived from ts
}

export interface SlackReaction {
  name: string;
  count: number;
  userIds: string[];
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url?: string;
}

// ─── Events API ──────────────────────────────────────────────────────────────

export interface SlackEventPayload {
  token: string;
  teamId: string;
  apiAppId: string;
  type: 'event_callback' | 'url_verification' | 'app_rate_limited';
  eventId?: string;
  eventTime?: number;
  event?: SlackEventInner;
  challenge?: string;     // url_verification only
}

export interface SlackEventInner {
  type: string;
  eventTs: string;
  user?: string;
  channel?: string;
  ts?: string;
  text?: string;
  subtype?: string;
  threadTs?: string;
  [key: string]: unknown;
}

// Specific event shapes
export interface SlackMessageEvent extends SlackEventInner {
  type: 'message';
  user: string;
  text: string;
  ts: string;
  channel: string;
  channelType: SlackChannelType;
  subtype?: string;
  threadTs?: string;
  edited?: { user: string; ts: string };
}

export interface SlackChannelCreatedEvent extends SlackEventInner {
  type: 'channel_created';
  channel: {
    id: string;
    name: string;
    created: number;
    creator: string;
  };
}

export interface SlackAppUninstalledEvent extends SlackEventInner {
  type: 'app_uninstalled';
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

export interface SlackOAuthResult {
  workspaceId: string;    // team.id
  workspaceName: string;  // team.name
  botToken: string;
  botUserId: string;
  installedByUserId: string;
  scope: string;
  appId: string;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export interface SlackPaginationOptions {
  cursor?: string;
  limit?: number;         // Default 100, max 200
  oldest?: string;        // Unix timestamp string
  latest?: string;
}

export interface SlackPaginatedResult<T> {
  items: T[];
  nextCursor?: string;    // Undefined = no more pages
  hasMore: boolean;
}

// ─── Send Message ─────────────────────────────────────────────────────────────

export interface SendMessageOptions {
  workspaceId: string;
  channelId: string;
  text: string;
  threadTs?: string;
  blocks?: unknown[];
  mrkdwn?: boolean;
}

export interface SendMessageResult {
  ts: string;
  channelId: string;
  message: SlackMessage;
}