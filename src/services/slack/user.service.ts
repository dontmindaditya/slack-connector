import { getSlackClient } from '../../config/slack';
import type { SlackUser } from '../../types/slack.types';
import { withRetry } from '../../utils/retry';
import { lruCache } from '../../utils/cache';
import { logger } from '../../utils/logger';

export class UserService {
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Fetches a single user by Slack user ID.
   * Results are cached to avoid hammering the API on every message sync.
   */
  async getUser(
    botToken: string,
    workspaceId: string,
    slackUserId: string
  ): Promise<SlackUser | null> {
    const cacheKey = `user:${workspaceId}:${slackUserId}`;
    const cached = lruCache.get<SlackUser>(cacheKey);
    if (cached) return cached;

    const client = getSlackClient(botToken);

    const response = await withRetry(
      () => client.users.info({ user: slackUserId }),
      { retries: 3, label: 'slack.users.info' }
    );

    if (!response.ok) {
      if (response.error === 'user_not_found') return null;
      throw new Error(`users.info failed: ${response.error}`);
    }

    const user = this._normalizeUser(
      response.user as Record<string, unknown>,
      workspaceId
    );

    lruCache.set(cacheKey, user, this.CACHE_TTL_MS);
    return user;
  }

  /**
   * Lists all users in a workspace with cursor pagination.
   */
  async listUsers(
    botToken: string,
    workspaceId: string,
    cursor?: string
  ): Promise<{ users: SlackUser[]; nextCursor?: string }> {
    const client = getSlackClient(botToken);

    const response = await withRetry(
      () => client.users.list({ limit: 200, cursor }),
      { retries: 3, label: 'slack.users.list' }
    );

    if (!response.ok) {
      throw new Error(`users.list failed: ${response.error}`);
    }

    const rawMembers = (response.members ?? []) as Record<string, unknown>[];
    const users = rawMembers
      .filter((m) => !((m['is_app_user'] as boolean) && (m['deleted'] as boolean)))
      .map((m) => this._normalizeUser(m, workspaceId));

    const nextCursor = (response.response_metadata as Record<string, string> | undefined)
      ?.next_cursor;

    logger.debug(
      { workspaceId, count: users.length },
      '[UserService] Listed users'
    );

    return { users, nextCursor: nextCursor || undefined };
  }

  /**
   * Lists ALL users across all pages — use for bulk sync only.
   */
  async listAllUsers(botToken: string, workspaceId: string): Promise<SlackUser[]> {
    const allUsers: SlackUser[] = [];
    let cursor: string | undefined;

    do {
      const { users, nextCursor } = await this.listUsers(botToken, workspaceId, cursor);
      allUsers.push(...users);
      cursor = nextCursor;
    } while (cursor);

    return allUsers;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private _normalizeUser(raw: Record<string, unknown>, workspaceId: string): SlackUser {
    const profile = (raw['profile'] ?? {}) as Record<string, unknown>;

    return {
      id: raw['id'] as string,
      workspaceId,
      name: raw['name'] as string,
      realName: (raw['real_name'] ?? profile['real_name'] ?? '') as string,
      displayName: (profile['display_name'] ?? raw['name'] ?? '') as string,
      email: profile['email'] as string | undefined,
      avatarUrl: (profile['image_192'] ?? profile['image_72']) as string | undefined,
      isBot: (raw['is_bot'] as boolean) ?? false,
      isAdmin: (raw['is_admin'] as boolean) ?? false,
      isDeleted: (raw['deleted'] as boolean) ?? false,
      timezone: raw['tz'] as string | undefined,
      updatedAt: new Date(((raw['updated'] as number) ?? 0) * 1000),
    };
  }
}