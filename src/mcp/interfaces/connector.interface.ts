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
  SyncOptions,
  SyncResult,
  OAuthInstallOptions,
  OAuthCallbackParams,
  OAuthInstallResult,
} from '../../types/mcp.types';


 */
export interface IConnector {
  // ─── Identity ─────────────────────────────────────────────────────────────

  /**
   * Returns static metadata about this connector.
   * No context required — this is connector-level, not workspace-level.
   */
  getMeta(): ConnectorMeta;

  // ─── OAuth / Installation ──────────────────────────────────────────────────

  /**
   * Returns the URL to redirect the user to for OAuth installation.
   * @param options  Optional state, scopes, and redirect URI overrides
   */
  getInstallUrl(options?: OAuthInstallOptions): string;

  /**
   * Handles the OAuth callback after the user authorizes the app.
   * Exchanges the code for tokens, persists the workspace to DB.
   * @returns OAuthInstallResult containing the new workspaceId
   */
  handleOAuthCallback(params: OAuthCallbackParams): Promise<OAuthInstallResult>;

  // ─── Channels ─────────────────────────────────────────────────────────────

  /**
   * Lists all channels the bot has access to in the given workspace.
   * Supports cursor-based pagination.
   */
  getChannels(ctx: ConnectorContext, options?: GetChannelsOptions): Promise<GetChannelsResult>;

  // ─── Messages ─────────────────────────────────────────────────────────────

  /**
   * Fetches messages from a specific channel.
   * Supports cursor pagination and time-range filtering.
   */
  getMessages(
    ctx: ConnectorContext,
    channelId: string,
    options?: GetMessagesOptions
  ): Promise<GetMessagesResult>;

  /**
   * Sends a message to a channel.
   * Optionally reply in a thread.
   */
  sendMessage(ctx: ConnectorContext, options: SendMessageOptions): Promise<SendMessageResult>;

  // ─── Events ───────────────────────────────────────────────────────────────

  /**
   * Processes a raw inbound event payload from the platform webhook.
   * Normalizes it into an MCPEvent and returns it for further handling.
   * Returns null if the event should be ignored (e.g. bot's own messages).
   *
   * @param rawPayload  The raw HTTP body from the platform webhook
   */
  handleEvent(rawPayload: unknown): Promise<MCPEvent | null>;

  // ─── Sync ─────────────────────────────────────────────────────────────────

  /**
   * Full or incremental sync of messages (and optionally channels/users)
   * from the platform into Supabase.
   *
   * Designed to be called by BullMQ jobs, not directly from API handlers.
   */
  sync(ctx: ConnectorContext, options?: SyncOptions): Promise<SyncResult>;

  // ─── Health ───────────────────────────────────────────────────────────────

  /**
   * Verifies the bot token is valid and the workspace is reachable.
   * Used for health checks and post-install verification.
   */
  verifyConnection(ctx: ConnectorContext): Promise<boolean>;

  /**
   * Cleans up all resources for a workspace — called on app_uninstalled.
   * Should revoke tokens, mark workspace inactive, clean up cache.
   */
  teardownWorkspace(ctx: ConnectorContext): Promise<void>;
}
