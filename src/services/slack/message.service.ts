import { getSlackClient } from '../../config/slack';
import type {
  SlackMessage,
  SlackReaction,
  SlackFile,
  SlackPaginatedResult,
  SlackPaginationOptions,
  SendMessageOptions,
  SendMessageResult,
} from '../../types/slack.types';
import { withRetry } from '../../utils/retry';
import { logger } from '../../utils/logger';

export class MessageService {
  /**
   * Fetches messages from a channel with cursor-based pagination.
   * Returns normalized SlackMessage objects.
   */
  async getChannelMessages(
    botToken: string,
    workspaceId: string,
    channelId: string,
    options: SlackPaginationOptions = {}
  ): Promise<SlackPaginatedResult<SlackMessage>> {
    const client = getSlackClient(botToken);

    const response = await withRetry(
      () =>
        client.conversations.history({
          channel: channelId,
          limit: Math.min(options.limit ?? 50, 200),
          cursor: options.cursor,
          oldest: options.oldest,
          latest: options.latest,
          inclusive: true,
        }),
      { retries: 3, label: 'slack.conversations.history' }
    );

    if (!response.ok) {
      throw new Error(`conversations.history failed for channel ${channelId}: ${response.error}`);
    }

    const rawMessages = (response.messages ?? []) as Record<string, unknown>[];

    const messages: SlackMessage[] = rawMessages
      .filter((m) => m['type'] === 'message')
      .map((m) => this._normalizeMessage(m, workspaceId, channelId));

    const nextCursor = (response.response_metadata as Record<string, string> | undefined)
      ?.next_cursor;

    logger.debug(
      { workspaceId, channelId, count: messages.length },
      '[MessageService] Fetched messages'
    );

    return {
      items: messages,
      nextCursor: nextCursor || undefined,
      hasMore: !!nextCursor,
    };
  }

  /**
   * Fetches all replies in a thread.
   */
  async getThreadReplies(
    botToken: string,
    workspaceId: string,
    channelId: string,
    threadTs: string,
    options: SlackPaginationOptions = {}
  ): Promise<SlackPaginatedResult<SlackMessage>> {
    const client = getSlackClient(botToken);

    const response = await withRetry(
      () =>
        client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: Math.min(options.limit ?? 50, 200),
          cursor: options.cursor,
        }),
      { retries: 3, label: 'slack.conversations.replies' }
    );

    if (!response.ok) {
      throw new Error(`conversations.replies failed: ${response.error}`);
    }

    const rawMessages = (response.messages ?? []) as Record<string, unknown>[];

    // First message is the parent — skip it
    const replies: SlackMessage[] = rawMessages
      .slice(1)
      .map((m) => this._normalizeMessage(m, workspaceId, channelId));

    const nextCursor = (response.response_metadata as Record<string, string> | undefined)
      ?.next_cursor;

    return {
      items: replies,
      nextCursor: nextCursor || undefined,
      hasMore: !!nextCursor,
    };
  }

  /**
   * Sends a message to a channel.
   * Supports threading via threadTs.
   */
  async sendMessage(botToken: string, options: SendMessageOptions): Promise<SendMessageResult> {
    const client = getSlackClient(botToken);

    const response = await withRetry(
      () =>
        client.chat.postMessage({
          channel: options.channelId,
          text: options.text,
          thread_ts: options.threadTs,
          blocks: options.blocks as Parameters<typeof client.chat.postMessage>[0]['blocks'],
          mrkdwn: options.mrkdwn ?? true,
        }),
      { retries: 2, label: 'slack.chat.postMessage' }
    );

    if (!response.ok) {
      throw new Error(`chat.postMessage failed: ${response.error}`);
    }

    const message = this._normalizeMessage(
      response.message as Record<string, unknown>,
      options.workspaceId,
      options.channelId
    );

    logger.info(
      { workspaceId: options.workspaceId, channelId: options.channelId, ts: response.ts },
      '[MessageService] Message sent'
    );

    return {
      ts: response.ts as string,
      channelId: response.channel as string,
      message,
    };
  }

  /**
   * Updates an existing message.
   */
  async updateMessage(
    botToken: string,
    channelId: string,
    ts: string,
    text: string,
    blocks?: unknown[]
  ): Promise<void> {
    const client = getSlackClient(botToken);

    const response = await withRetry(
      () =>
        client.chat.update({
          channel: channelId,
          ts,
          text,
          blocks: blocks as Parameters<typeof client.chat.update>[0]['blocks'],
        }),
      { retries: 2, label: 'slack.chat.update' }
    );

    if (!response.ok) {
      throw new Error(`chat.update failed: ${response.error}`);
    }
  }

  /**
   * Deletes a message.
   */
  async deleteMessage(botToken: string, channelId: string, ts: string): Promise<void> {
    const client = getSlackClient(botToken);

    const response = await withRetry(
      () => client.chat.delete({ channel: channelId, ts }),
      { retries: 2, label: 'slack.chat.delete' }
    );

    if (!response.ok) {
      throw new Error(`chat.delete failed: ${response.error}`);
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private _normalizeMessage(
    raw: Record<string, unknown>,
    workspaceId: string,
    channelId: string
  ): SlackMessage {
    const ts = raw['ts'] as string;
    const editedRaw = raw['edited'] as Record<string, string> | undefined;

    const reactions: SlackReaction[] = ((raw['reactions'] ?? []) as Record<string, unknown>[]).map(
      (r) => ({
        name: r['name'] as string,
        count: r['count'] as number,
        userIds: (r['users'] ?? []) as string[],
      })
    );

    const files: SlackFile[] = ((raw['files'] ?? []) as Record<string, unknown>[]).map((f) => ({
      id: f['id'] as string,
      name: f['name'] as string,
      mimetype: f['mimetype'] as string,
      size: f['size'] as number,
      url: (f['url_private'] ?? f['permalink']) as string | undefined,
    }));

    return {
      ts,
      workspaceId,
      channelId,
      userId: (raw['user'] ?? raw['bot_id'] ?? '') as string,
      text: (raw['text'] ?? '') as string,
      subtype: raw['subtype'] as SlackMessage['subtype'],
      threadTs: raw['thread_ts'] as string | undefined,
      replyCount: (raw['reply_count'] as number) ?? 0,
      reactions,
      files,
      blocks: raw['blocks'] as unknown[] | undefined,
      editedAt: editedRaw?.ts ? new Date(parseFloat(editedRaw.ts) * 1000) : undefined,
      createdAt: new Date(parseFloat(ts) * 1000),
    };
  }
}