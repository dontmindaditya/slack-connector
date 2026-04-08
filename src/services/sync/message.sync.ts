import { WorkspaceRepo } from '../supabase/workspace.repo';
import { ChannelRepo } from '../supabase/channel.repo';
import { MessageRepo } from '../supabase/message.repo';
import { UserRepo } from '../supabase/user.repo';
import { MessageService } from '../slack/message.service';
import { UserService } from '../slack/user.service';
import type { MessageInsert, UserInsert } from '../../types/supabase.types';
import type { SlackMessage } from '../../types/slack.types';
import { SyncError } from '../../types/mcp.types';
import { logger } from '../../utils/logger';
import { decryptToken } from '../../utils/encryption';
import { env } from '../../config/env';

export interface MessageSyncOptions {
  channelId?: string;       // Specific channel or all channels
  since?: Date;             // Incremental: only messages after this date
  fullSync?: boolean;       // Ignore since, sync everything
  limit?: number;           // Max messages per channel (default: 1000)
}

export interface MessageSyncResult {
  synced: number;
  usersDiscovered: number;
  errors: SyncError[];
}

export class MessageSyncService {
  private readonly workspaceRepo: WorkspaceRepo;
  private readonly channelRepo: ChannelRepo;
  private readonly messageRepo: MessageRepo;
  private readonly userRepo: UserRepo;
  private readonly messageService: MessageService;
  private readonly userService: UserService;

  constructor() {
    this.workspaceRepo = new WorkspaceRepo();
    this.channelRepo = new ChannelRepo();
    this.messageRepo = new MessageRepo();
    this.userRepo = new UserRepo();
    this.messageService = new MessageService();
    this.userService = new UserService();
  }

  /**
   * Main entry point for message sync.
   * Syncs one or all channels for a workspace — incremental or full.
   */
  async syncMessages(
    workspaceId: string,
    options: MessageSyncOptions = {}
  ): Promise<MessageSyncResult> {
    const errors: SyncError[] = [];
    let totalSynced = 0;
    let totalUsersDiscovered = 0;

    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw new Error(`[MessageSyncService] Workspace not found: ${workspaceId}`);
    }

    // Determine which channels to sync
    let channelIds: string[];

    if (options.channelId) {
      // Single channel — validate it exists
      const channel = await this.channelRepo.findBySlackChannelId(workspaceId, options.channelId);
      if (!channel) {
        throw new Error(`[MessageSyncService] Channel not found: ${options.channelId}`);
      }
      channelIds = [channel.slack_channel_id];
    } else {
      // All channels the bot is member of
      const channels = await this.channelRepo.listByWorkspace(workspaceId, {
        includeArchived: false,
      });
      channelIds = channels
        .filter((c) => c.is_member)
        .map((c) => c.slack_channel_id);
    }

    logger.info(
      { workspaceId, channelCount: channelIds.length },
      '[MessageSyncService] Starting message sync'
    );

    // Sync each channel
    for (const slackChannelId of channelIds) {
      try {
        const { synced, usersDiscovered } = await this._syncChannel(
          workspace.id,
          decryptToken(workspace.bot_token, env.TOKEN_ENCRYPTION_KEY),
          slackChannelId,
          options
        );
        totalSynced += synced;
        totalUsersDiscovered += usersDiscovered;
      } catch (err) {
        const message = (err as Error).message;
        logger.error(
          { workspaceId, channelId: slackChannelId, err: message },
          '[MessageSyncService] Channel sync failed'
        );
        errors.push({ channelId: slackChannelId, message });
        // Continue to next channel — don't abort the whole sync
      }
    }

    logger.info(
      { workspaceId, totalSynced, totalUsersDiscovered, errorCount: errors.length },
      '[MessageSyncService] Message sync complete'
    );

    return { synced: totalSynced, usersDiscovered: totalUsersDiscovered, errors };
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  /**
   * Syncs messages for a single channel.
   * Uses incremental sync by default (reads latest ts from DB).
   */
  private async _syncChannel(
    workspaceId: string,
    botToken: string,
    slackChannelId: string,
    options: MessageSyncOptions
  ): Promise<{ synced: number; usersDiscovered: number }> {
    // Get the internal channel record for its UUID
    const channelRecord = await this.channelRepo.findBySlackChannelId(
      workspaceId,
      slackChannelId
    );
    if (!channelRecord) {
      throw new Error(`Channel record not found for slack_channel_id: ${slackChannelId}`);
    }

    // Determine oldest timestamp for incremental sync.
    // Fix: parentheses are required — `??` has lower precedence than `? :`,
    // so without them the ternary always fires when latestTs is truthy.
    let oldest: string | undefined;
    if (!options.fullSync) {
      const latestTs = await this.messageRepo.getLatestTs(workspaceId, channelRecord.id);
      oldest = latestTs ?? (options.since
        ? String(Math.floor(options.since.getTime() / 1000))
        : undefined);
    }

    const maxMessages = options.limit ?? 1000;
    const allMessages: SlackMessage[] = [];
    let cursor: string | undefined;

    // Paginate through Slack API
    do {
      const result = await this.messageService.getChannelMessages(
        botToken,
        workspaceId,
        slackChannelId,
        { limit: 200, cursor, oldest }
      );

      allMessages.push(...result.items);
      cursor = result.nextCursor;

      // Don't exceed max
      if (allMessages.length >= maxMessages) break;
    } while (cursor);

    if (allMessages.length === 0) {
      return { synced: 0, usersDiscovered: 0 };
    }

    // Collect unique user IDs to discover
    const seenUserIds = new Set<string>();
    const messageInserts: MessageInsert[] = allMessages.map((msg) => {
      if (msg.userId && !msg.userId.startsWith('B')) {
        seenUserIds.add(msg.userId);
      }

      return {
        workspace_id: workspaceId,
        channel_id: channelRecord.id,
        slack_ts: msg.ts,
        slack_user_id: msg.userId,
        text: msg.text,
        subtype: msg.subtype ?? null,
        thread_ts: msg.threadTs ?? null,
        reply_count: msg.replyCount ?? 0,
        reactions: msg.reactions ?? [],
        files: msg.files ?? [],
        blocks: msg.blocks ?? [],
        edited_at: msg.editedAt?.toISOString() ?? null,
        slack_created_at: msg.createdAt.toISOString(),
      };
    });

    // Write messages to DB
    const synced = await this.messageRepo.bulkUpsert(messageInserts);

    // Update channel last_synced_at
    await this.channelRepo.updateLastSynced(workspaceId, slackChannelId);

    // Discover new users (upsert any we haven't seen before)
    const usersDiscovered = await this._discoverUsers(
      workspaceId,
      botToken,
      Array.from(seenUserIds)
    );

    logger.debug(
      { workspaceId, slackChannelId, synced, usersDiscovered },
      '[MessageSyncService] Channel sync done'
    );

    return { synced, usersDiscovered };
  }

  /**
   * For each user ID seen in messages, fetch and upsert user if not already in DB.
   *
   * Algorithm:
   *   1. Single batch DB query to find which user IDs are already known.
   *   2. For unknown IDs only, call Slack API in parallel (Promise.allSettled).
   *   3. Bulk-upsert all discovered users in one DB call.
   *
   * This replaces the previous O(n) serial approach (N DB round-trips + N Slack calls)
   * with O(1) DB round-trips and parallel Slack calls.
   */
  private async _discoverUsers(
    workspaceId: string,
    botToken: string,
    slackUserIds: string[]
  ): Promise<number> {
    if (slackUserIds.length === 0) return 0;

    // Step 1: batch existence check — one DB query instead of N
    const existingUsers = await this.userRepo.findManyBySlackUserIds(workspaceId, slackUserIds);
    const knownIds = new Set(existingUsers.map((u) => u.slack_user_id));
    const unknownIds = slackUserIds.filter((id) => !knownIds.has(id));

    if (unknownIds.length === 0) return 0;

    // Step 2: fetch unknown users from Slack API in parallel
    const results = await Promise.allSettled(
      unknownIds.map((slackUserId) =>
        this.userService.getUser(botToken, workspaceId, slackUserId)
      )
    );

    const now = new Date().toISOString();
    const userInserts: UserInsert[] = [];

    for (const result of results) {
      if (result.status === 'rejected' || !result.value) continue;
      const user = result.value;

      userInserts.push({
        workspace_id: workspaceId,
        slack_user_id: user.id,
        name: user.name,
        real_name: user.realName,
        display_name: user.displayName,
        email: user.email ?? null,
        avatar_url: user.avatarUrl ?? null,
        is_bot: user.isBot,
        is_admin: user.isAdmin,
        is_deleted: user.isDeleted,
        timezone: user.timezone ?? null,
        last_synced_at: now,
      });
    }

    // Step 3: bulk upsert in one DB call
    if (userInserts.length === 0) return 0;
    return this.userRepo.bulkUpsert(userInserts);
  }
}