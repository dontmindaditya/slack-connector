import { WorkspaceRepo } from '../supabase/workspace.repo';
import { ChannelRepo } from '../supabase/channel.repo';
import { ChannelService } from '../slack/channel.service';
import type { ChannelInsert } from '../../types/supabase.types';
import type { SlackChannel } from '../../types/slack.types';
import { logger } from '../../utils/logger';
import { decryptToken } from '../../utils/encryption';
import { env } from '../../config/env';

export interface ChannelSyncResult {
  synced: number;
  errors: Array<{ message: string }>;
}

export class ChannelSyncService {
  private readonly workspaceRepo: WorkspaceRepo;
  private readonly channelRepo: ChannelRepo;
  private readonly channelService: ChannelService;

  constructor() {
    this.workspaceRepo = new WorkspaceRepo();
    this.channelRepo = new ChannelRepo();
    this.channelService = new ChannelService();
  }

  /**
   * Fetches all Slack channels for a workspace and upserts them into Supabase.
   * Always does a full sync — channels list is small enough to handle this.
   */
  async syncChannels(workspaceId: string): Promise<ChannelSyncResult> {
    const errors: ChannelSyncResult['errors'] = [];

    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw new Error(`[ChannelSyncService] Workspace not found: ${workspaceId}`);
    }

    logger.info({ workspaceId }, '[ChannelSyncService] Starting channel sync');

    let allChannels: SlackChannel[] = [];

    try {
      allChannels = await this.channelService.listAllChannels(
        decryptToken(workspace.bot_token, env.TOKEN_ENCRYPTION_KEY),
        workspaceId,
        {
          excludeArchived: false, // Sync everything including archived
          types: ['public_channel', 'private_channel'],
        }
      );
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ workspaceId, err: message }, '[ChannelSyncService] Failed to list channels');
      errors.push({ message });
      return { synced: 0, errors };
    }

    // Map to DB insert shape
    const inserts: ChannelInsert[] = allChannels.map((ch) => ({
      workspace_id: workspaceId,
      slack_channel_id: ch.id,
      name: ch.name,
      type: ch.type,
      is_archived: ch.isArchived,
      is_member: ch.isMember,
      topic: ch.topic ?? null,
      purpose: ch.purpose ?? null,
      member_count: ch.memberCount ?? null,
    }));

    let synced = 0;
    try {
      synced = await this.channelRepo.bulkUpsert(inserts);
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ workspaceId, err: message }, '[ChannelSyncService] Bulk upsert failed');
      errors.push({ message });
    }

    logger.info({ workspaceId, synced }, '[ChannelSyncService] Channel sync complete');
    return { synced, errors };
  }
}