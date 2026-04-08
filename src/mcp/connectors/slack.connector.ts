import type { IConnector } from '../interfaces/connector.interface';
import type {
  ConnectorMeta,
  ConnectorContext,
  GetChannelsOptions,
  GetChannelsResult,
  GetMessagesOptions,
  GetMessagesResult,
  SendMessageOptions,
  SendMessageResult,
  MCPEvent,
  MCPMessage,
  MCPChannel,
  SyncOptions,
  SyncResult,
  OAuthInstallOptions,
  OAuthCallbackParams,
  OAuthInstallResult,
} from '../../types/mcp.types';
import type { SlackMessageEvent } from '../../types/slack.types';

import crypto from 'crypto';
import { slackOAuthConfig } from '../../config/slack';
import { env } from '../../config/env';

import { AuthService } from '../../services/slack/auth.service';
import { ChannelService } from '../../services/slack/channel.service';
import { MessageService } from '../../services/slack/message.service';
import { WorkspaceRepo } from '../../services/supabase/workspace.repo';
import { MessageSyncService } from '../../services/sync/message.sync';
import { ChannelSyncService } from '../../services/sync/channel.sync';

import { ConnectorError, ConnectorAuthError, ConnectorNotFoundError } from '../../types/mcp.types';
import { logger } from '../../utils/logger';
import { decryptToken } from '../../utils/encryption';
import { lruCache } from '../../utils/cache';

/**
 * SlackConnector — implements IConnector for the Slack platform.
 *
 * This class is the single point of entry for all Slack operations.
 * It delegates to domain services (auth, channel, message, sync) and
 * normalizes Slack-specific types into MCP-generic types.
 *
 * Collectium core only ever calls IConnector methods — it never
 * imports from services/slack/* directly.
 */
export class SlackConnector implements IConnector {
  private readonly authService: AuthService;
  private readonly channelService: ChannelService;
  private readonly messageService: MessageService;
  private readonly workspaceRepo: WorkspaceRepo;
  private readonly messageSyncService: MessageSyncService;
  private readonly channelSyncService: ChannelSyncService;

  constructor() {
    this.authService = new AuthService();
    this.channelService = new ChannelService();
    this.messageService = new MessageService();
    this.workspaceRepo = new WorkspaceRepo();
    this.messageSyncService = new MessageSyncService();
    this.channelSyncService = new ChannelSyncService();
  }

  // ─── Identity ───────────────────────────────────────────────────────────────

  getMeta(): ConnectorMeta {
    return {
      id: 'slack',
      name: 'Slack',
      version: '1.0.0',
      description: 'Slack connector for reading/writing messages and syncing workspace data',
      capabilities: [
        'read_messages',
        'send_messages',
        'list_channels',
        'sync_messages',
        'handle_events',
        'oauth_install',
      ],
    };
  }

  // ─── OAuth ───────────────────────────────────────────────────────────────────

  getInstallUrl(options?: OAuthInstallOptions): string {
    const scopes = options?.scopes ?? slackOAuthConfig.scopes;
    const redirectUri = options?.redirectUri ?? slackOAuthConfig.redirectUri;
    const state = options?.state ?? this._generateState();

    // Store state for CSRF validation in the callback.
    // TTL of 10 minutes — matches typical OAuth flow duration.
    // Note: this is process-local. For multi-instance deployments, replace
    // lruCache with a Redis-backed store keyed on state.
    lruCache.set(`oauth_state:${state}`, true, 10 * 60 * 1000);

    const params = new URLSearchParams({
      client_id: slackOAuthConfig.clientId,
      scope: scopes.join(','),
      redirect_uri: redirectUri,
      state,
    });

    return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  }

  async handleOAuthCallback(params: OAuthCallbackParams): Promise<OAuthInstallResult> {
    if (params.error) {
      throw new ConnectorError(
        `OAuth denied: ${params.error}`,
        'OAUTH_DENIED',
        'slack',
        400
      );
    }

    if (!params.code) {
      throw new ConnectorError('Missing authorization code', 'OAUTH_MISSING_CODE', 'slack', 400);
    }

    // CSRF state validation — reject callbacks with unknown/expired state.
    // Consume on first use so the same state cannot be replayed.
    if (params.state) {
      const stateKey = `oauth_state:${params.state}`;
      const valid = lruCache.get<boolean>(stateKey) === true;
      if (!valid) {
        throw new ConnectorError(
          'Invalid or expired OAuth state — possible CSRF attack',
          'OAUTH_INVALID_STATE',
          'slack',
          400
        );
      }
      lruCache.delete(stateKey); // One-time use
    }

    const result = await this.authService.exchangeCode(params.code);

    logger.info({ workspaceId: result.workspaceId }, '[SlackConnector] OAuth install complete');

    return {
      workspaceId: result.workspaceId,
      workspaceName: result.workspaceName,
      installedAt: new Date(),
      redirectUrl: `${env.APP_BASE_URL}/slack/install/success`,
    };
  }

  // ─── Channels ────────────────────────────────────────────────────────────────

  async getChannels(
    ctx: ConnectorContext,
    options?: GetChannelsOptions
  ): Promise<GetChannelsResult> {
    const token = await this._resolveToken(ctx);

    const result = await this.channelService.listChannels(token, ctx.workspaceId, {
      excludeArchived: !options?.includeArchived,
      limit: options?.limit ?? 100,
      cursor: options?.cursor,
    });

    const channels: MCPChannel[] = result.channels.map((ch) => ({
      id: ch.id,
      workspaceId: ctx.workspaceId,
      name: ch.name,
      type: ch.type,
      isArchived: ch.isArchived,
      memberCount: ch.memberCount,
    }));

    return {
      channels,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  // ─── Messages ────────────────────────────────────────────────────────────────

  async getMessages(
    ctx: ConnectorContext,
    channelId: string,
    options?: GetMessagesOptions
  ): Promise<GetMessagesResult> {
    const token = await this._resolveToken(ctx);

    const result = await this.messageService.getChannelMessages(
      token,
      ctx.workspaceId,
      channelId,
      {
        limit: options?.limit ?? 50,
        cursor: options?.cursor,
        oldest: options?.after,
        latest: options?.before,
      }
    );

    const messages: MCPMessage[] = result.items.map((msg) => ({
      id: msg.ts,
      workspaceId: ctx.workspaceId,
      channelId: msg.channelId,
      authorId: msg.userId,
      text: msg.text,
      threadId: msg.threadTs,
      reactions: msg.reactions?.map((r) => ({
        emoji: r.name,
        count: r.count,
        userIds: r.userIds,
      })),
      createdAt: msg.createdAt,
      editedAt: msg.editedAt,
      metadata: { subtype: msg.subtype, blocks: msg.blocks },
    }));

    return {
      messages,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  async sendMessage(ctx: ConnectorContext, options: SendMessageOptions): Promise<SendMessageResult> {
    const token = await this._resolveToken(ctx);

    const result = await this.messageService.sendMessage(token, {
      workspaceId: ctx.workspaceId,
      channelId: options.channelId,
      text: options.text,
      threadTs: options.threadId,
      blocks: options.metadata?.blocks as unknown[] | undefined,
    });

    return {
      messageId: result.ts,
      channelId: result.channelId,
      createdAt: new Date(parseFloat(result.ts) * 1000),
    };
  }

  // ─── Events ──────────────────────────────────────────────────────────────────

  async handleEvent(rawPayload: unknown): Promise<MCPEvent | null> {
    const payload = rawPayload as Record<string, unknown>;

    // url_verification handshake — return null (handled at webhook layer)
    if (payload['type'] === 'url_verification') return null;

    if (payload['type'] !== 'event_callback') return null;

    const event = payload['event'] as Record<string, unknown>;
    if (!event) return null;

    const teamId = payload['team_id'] as string;

    // Resolve workspaceId from Slack team_id
    const workspace = await this.workspaceRepo.findBySlackTeamId(teamId);
    if (!workspace) {
      logger.warn({ teamId }, '[SlackConnector] Event received for unknown workspace');
      return null;
    }

    // Normalize to MCPEvent
    return this._normalizeEvent(workspace.id, event);
  }

  // ─── Sync ─────────────────────────────────────────────────────────────────────

  async sync(ctx: ConnectorContext, options?: SyncOptions): Promise<SyncResult> {
    const startedAt = new Date();
    const errors: SyncResult['errors'] = [];
    let channelsSynced = 0;
    let messagesSynced = 0;
    let usersDiscovered = 0;

    logger.info({ workspaceId: ctx.workspaceId }, '[SlackConnector] Starting sync');

    try {
      // 1. Sync channel list
      const channelSyncResult = await this.channelSyncService.syncChannels(ctx.workspaceId);
      channelsSynced = channelSyncResult.synced;

      // 2. Sync messages per channel
      const targetChannelId = options?.channelId;
      const msgSyncResult = await this.messageSyncService.syncMessages(ctx.workspaceId, {
        channelId: targetChannelId,
        since: options?.since,
        fullSync: options?.fullSync,
        limit: options?.limit,
      });

      messagesSynced = msgSyncResult.synced;
      usersDiscovered = msgSyncResult.usersDiscovered;
      errors.push(...msgSyncResult.errors);
    } catch (err) {
      errors.push({ message: (err as Error).message });
    }

    const completedAt = new Date();

    return {
      workspaceId: ctx.workspaceId,
      channelsSynced,
      messagesSynced,
      usersDiscovered,
      errors,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }

  // ─── Health ──────────────────────────────────────────────────────────────────

  async verifyConnection(ctx: ConnectorContext): Promise<boolean> {
    try {
      const token = await this._resolveToken(ctx);
      return await this.authService.verifyToken(token);
    } catch {
      return false;
    }
  }

  async teardownWorkspace(ctx: ConnectorContext): Promise<void> {
    await this.authService.revokeWorkspace(ctx.workspaceId);
    logger.info({ workspaceId: ctx.workspaceId }, '[SlackConnector] Workspace torn down');
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Resolves the bot token for a workspaceId.
   * Throws ConnectorAuthError if workspace not found or inactive.
   */
  private async _resolveToken(ctx: ConnectorContext): Promise<string> {
    const workspace = await this.workspaceRepo.findById(ctx.workspaceId);

    if (!workspace) {
      throw new ConnectorNotFoundError('slack', `Workspace ${ctx.workspaceId}`);
    }

    if (!workspace.is_active) {
      throw new ConnectorAuthError('slack', 'Workspace is inactive or has been uninstalled');
    }

    // Decrypt the stored token — decryptToken is a no-op if encryption is
    // not configured or the value is already plaintext (legacy rows).
    return decryptToken(workspace.bot_token, env.TOKEN_ENCRYPTION_KEY);
  }

  /**
   * Normalizes a raw Slack inner event into an MCPEvent.
   */
  private _normalizeEvent(workspaceId: string, event: Record<string, unknown>): MCPEvent {
    const eventType = event['type'] as string;
    const subtype = event['subtype'] as string | undefined;

    // Map Slack event types to MCP event types
    let mcpType: string;
    if (eventType === 'message') {
      if (subtype === 'message_deleted') mcpType = 'message.deleted';
      else if (subtype === 'message_changed') mcpType = 'message.updated';
      else mcpType = 'message.created';
    } else if (eventType === 'channel_created') {
      mcpType = 'channel.created';
    } else if (eventType === 'channel_deleted') {
      mcpType = 'channel.deleted';
    } else if (eventType === 'member_joined_channel') {
      mcpType = 'member.joined';
    } else if (eventType === 'member_left_channel') {
      mcpType = 'member.left';
    } else if (eventType === 'app_uninstalled') {
      mcpType = 'app.uninstalled';
    } else {
      mcpType = eventType;
    }

    return {
      type: mcpType,
      workspaceId,
      timestamp: new Date((event['event_ts'] as string)
        ? parseFloat(event['event_ts'] as string) * 1000
        : Date.now()),
      payload: event as Record<string, unknown>,
      rawEvent: event,
    };
  }

  /**
   * Generates a random state parameter for OAuth CSRF protection.
   */
  private _generateState(): string {
    return crypto.randomBytes(16).toString('hex');
  }
}