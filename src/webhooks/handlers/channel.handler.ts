import type { MCPEvent } from '../../types/mcp.types';
import { getQueue, QUEUE_NAMES } from '../../queue/bullmq';
import { ChannelRepo } from '../../services/supabase/channel.repo';
import { logger } from '../../utils/logger';

const channelRepo = new ChannelRepo();


export async function handleChannelEvent(event: MCPEvent): Promise<void> {
  const { workspaceId, type, payload } = event;

  switch (type) {
    case 'channel.created':
      await _handleCreated(workspaceId, payload);
      break;

    case 'channel.deleted':
      await _handleDeleted(workspaceId, payload);
      break;

    case 'member.joined':
      await _handleMemberJoined(workspaceId, payload);
      break;

    default:
      logger.debug({ type, workspaceId }, '[ChannelHandler] Unhandled channel event type');
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function _handleCreated(
  workspaceId: string,
  payload: Record<string, unknown>
): Promise<void> {
  // Channel events don't include full channel info — trigger a sync to get it
  logger.info({ workspaceId }, '[ChannelHandler] channel.created — enqueuing channel sync');

  await getQueue(QUEUE_NAMES.CHANNEL_SYNC).add(
    'channel-created-sync',
    { workspaceId },
    { priority: 2 }
  );
}

async function _handleDeleted(
  workspaceId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const slackChannelId = payload['channel'] as string | undefined;
  if (!slackChannelId) return;

  const channel = await channelRepo.findBySlackChannelId(workspaceId, slackChannelId);
  if (!channel) return;

  try {
    await channelRepo.update(workspaceId, channel.id, { is_archived: true });
    logger.info(
      { workspaceId, slackChannelId },
      '[ChannelHandler] Channel marked archived in DB'
    );
  } catch (err) {
    logger.error({ err, workspaceId, slackChannelId }, '[ChannelHandler] Failed to archive channel');
    throw err;
  }
}

async function _handleMemberJoined(
  workspaceId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const slackChannelId = payload['channel'] as string | undefined;
  if (!slackChannelId) return;

  // Bot joined a new channel — start syncing its messages
  const inviterId = payload['inviter'] as string | undefined;
  logger.info(
    { workspaceId, slackChannelId, inviterId },
    '[ChannelHandler] Bot joined channel — enqueuing message sync'
  );

  await getQueue(QUEUE_NAMES.MESSAGE_SYNC).add(
    'new-channel-message-sync',
    { workspaceId, channelId: slackChannelId, fullSync: true },
    { delay: 3000, priority: 2 }
  );
}
