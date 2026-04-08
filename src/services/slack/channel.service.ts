import { getSlackClient } from '../../config/slack';
import type {
  SlackChannel,
  SlackChannelType,
  SlackPaginatedResult,
  SlackPaginationOptions,
} from '../../types/slack.types';
import { withRetry } from '../../utils/retry';
import { logger } from '../../utils/logger';

export interface ListChannelsOptions extends SlackPaginationOptions {
  excludeArchived?: boolean;
  types?: SlackChannelType[];
}

export class ChannelService {
  /**
   * Lists all channels the bot has access to.
   * Supports cursor pagination. Returns normalized SlackChannel objects.
   */
  async listChannels(
    botToken: string,
    workspaceId: string,
    options: ListChannelsOptions = {}
  ): Promise<SlackPaginatedResult<SlackChannel>> {
    const client = getSlackClient(botToken);

    const types = options.types ?? ['public_channel', 'private_channel'];

    const response = await withRetry(
      () =>
        client.conversations.list({
          exclude_archived: options.excludeArchived ?? true,
          types: types.join(','),
          limit: Math.min(options.limit ?? 100, 200),
          cursor: options.cursor,
        }),
      { retries: 3, label: 'slack.conversations.list' }
    );

    if (!response.ok) {
      throw new Error(`conversations.list failed: ${response.error}`);
    }

    const rawChannels = (response.channels ?? []) as Record<string, unknown>[];

    const channels: SlackChannel[] = rawChannels.map((ch) =>
      this._normalizeChannel(ch, workspaceId)
    );

    const nextCursor = (response.response_metadata as Record<string, string> | undefined)
      ?.next_cursor;

    logger.debug(
      { workspaceId, count: channels.length, hasMore: !!nextCursor },
      '[ChannelService] Listed channels'
    );

    return {
      items: channels,
      nextCursor: nextCursor || undefined,
      hasMore: !!nextCursor,
    };
  }

  /**
   * Fetches all channels across all pages (full list).
   * Use with caution on large workspaces — prefer paginated for API calls.
   */
  async listAllChannels(
    botToken: string,
    workspaceId: string,
    options: Omit<ListChannelsOptions, 'cursor'> = {}
  ): Promise<SlackChannel[]> {
    const allChannels: SlackChannel[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.listChannels(botToken, workspaceId, {
        ...options,
        cursor,
        limit: 200,
      });
      allChannels.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);

    return allChannels;
  }

  /**
   * Fetches info for a single channel by ID.
   */
  async getChannel(
    botToken: string,
    workspaceId: string,
    channelId: string
  ): Promise<SlackChannel | null> {
    const client = getSlackClient(botToken);

    const response = await withRetry(
      () => client.conversations.info({ channel: channelId }),
      { retries: 3, label: 'slack.conversations.info' }
    );

    if (!response.ok) {
      if (response.error === 'channel_not_found') return null;
      throw new Error(`conversations.info failed: ${response.error}`);
    }

    const ch = response.channel as Record<string, unknown> | undefined;
    if (!ch) return null;

    return this._normalizeChannel(ch, workspaceId);
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private _normalizeChannel(raw: Record<string, unknown>, workspaceId: string): SlackChannel {
    const purpose = raw['purpose'] as Record<string, unknown> | undefined;
    const topic = raw['topic'] as Record<string, unknown> | undefined;

    let type: SlackChannelType = 'public_channel';
    if (raw['is_private']) type = 'private_channel';
    else if (raw['is_mpim']) type = 'mpim';
    else if (raw['is_im']) type = 'im';

    return {
      id: raw['id'] as string,
      workspaceId,
      name: (raw['name'] as string) ?? '',
      type,
      isArchived: (raw['is_archived'] as boolean) ?? false,
      isMember: (raw['is_member'] as boolean) ?? false,
      topic: topic?.['value'] as string | undefined,
      purpose: purpose?.['value'] as string | undefined,
      memberCount: raw['num_members'] as number | undefined,
      createdAt: new Date(((raw['created'] as number) ?? 0) * 1000),
      updatedAt: new Date(),
    };
  }
}