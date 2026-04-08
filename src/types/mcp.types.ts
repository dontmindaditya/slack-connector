/**
 * MCP (Model Context Protocol) shared types.
 * These are connector-agnostic — Slack, Discord, Notion, Gmail all use these shapes.
 * The IConnector interface is defined in mcp/interfaces/connector.interface.ts.
 */

// ─── Connector Identity ───────────────────────────────────────────────────────

export type ConnectorId = 'slack' | 'discord' | 'notion' | 'gmail' | string;

export interface ConnectorMeta {
  id: ConnectorId;
  name: string;
  version: string;
  description: string;
  capabilities: ConnectorCapability[];
}

export type ConnectorCapability =
  | 'read_messages'
  | 'send_messages'
  | 'list_channels'
  | 'sync_messages'
  | 'handle_events'
  | 'oauth_install'
  | 'search_messages'
  | 'manage_members';

// ─── Context ─────────────────────────────────────────────────────────────────

/**
 * ConnectorContext is passed to every connector method call.
 * It carries the workspace scope and caller identity.
 * This is the core of multi-tenancy — no method runs without it.
 */
export interface ConnectorContext {
  workspaceId: string;    // Internal UUID from slack_workspaces.id
  requestId?: string;     // For tracing/logging
  callerUserId?: string;  // Collectium user who made the API call
}

// ─── Channels ─────────────────────────────────────────────────────────────────

export interface MCPChannel {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  isArchived: boolean;
  memberCount?: number;
  metadata?: Record<string, unknown>;
}

export interface GetChannelsOptions {
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface GetChannelsResult {
  channels: MCPChannel[];
  nextCursor?: string;
  hasMore: boolean;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface MCPMessage {
  id: string;             // Platform-native ID (Slack ts, Discord snowflake, etc.)
  workspaceId: string;
  channelId: string;
  authorId: string;
  text: string;
  threadId?: string;
  attachments?: MCPAttachment[];
  reactions?: MCPReaction[];
  createdAt: Date;
  editedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface MCPAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url?: string;
}

export interface MCPReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface GetMessagesOptions {
  limit?: number;
  cursor?: string;
  before?: string;
  after?: string;
  threadId?: string;
}

export interface GetMessagesResult {
  messages: MCPMessage[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface SendMessageOptions {
  channelId: string;
  text: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageResult {
  messageId: string;
  channelId: string;
  createdAt: Date;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type MCPEventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'channel.created'
  | 'channel.deleted'
  | 'member.joined'
  | 'member.left'
  | 'app.uninstalled'
  | string;

export interface MCPEvent {
  type: MCPEventType;
  workspaceId: string;
  timestamp: Date;
  payload: Record<string, unknown>;
  rawEvent?: unknown;     // Original platform event for debugging
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export interface SyncOptions {
  channelId?: string;     // If omitted, sync all channels
  since?: Date;           // Incremental sync from this timestamp
  fullSync?: boolean;     // Force full re-sync (ignores since)
  limit?: number;         // Max messages per channel per sync run
}

export interface SyncResult {
  workspaceId: string;
  channelsSynced: number;
  messagesSynced: number;
  usersDiscovered: number;
  errors: SyncError[];
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

export interface SyncError {
  channelId?: string;
  message: string;
  code?: string;
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export interface OAuthInstallOptions {
  state?: string;
  redirectUri?: string;
  scopes?: string[];
}

export interface OAuthCallbackParams {
  code: string;
  state?: string;
  error?: string;
}

export interface OAuthInstallResult {
  workspaceId: string;
  workspaceName: string;
  installedAt: Date;
  redirectUrl?: string;   // Where to send the user after install
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly connectorId: ConnectorId,
    public readonly statusCode: number = 500,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export class ConnectorAuthError extends ConnectorError {
  constructor(connectorId: ConnectorId, message = 'Authentication failed') {
    super(message, 'AUTH_ERROR', connectorId, 401);
    this.name = 'ConnectorAuthError';
  }
}

export class ConnectorNotFoundError extends ConnectorError {
  constructor(connectorId: ConnectorId, resource: string) {
    super(`${resource} not found`, 'NOT_FOUND', connectorId, 404);
    this.name = 'ConnectorNotFoundError';
  }
}

export class ConnectorRateLimitError extends ConnectorError {
  constructor(connectorId: ConnectorId, public readonly retryAfterMs: number) {
    super('Rate limit exceeded', 'RATE_LIMITED', connectorId, 429);
    this.name = 'ConnectorRateLimitError';
  }
}