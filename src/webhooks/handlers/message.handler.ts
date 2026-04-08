import type { MCPEvent } from '../../types/mcp.types';
import { getQueue, QUEUE_NAMES } from '../../queue/bullmq';
import { WorkspaceRepo } from '../../services/supabase/workspace.repo';
import { ChannelRepo } from '../../services/supabase/channel.repo';
import { MessageRepo } from '../../services/supabase/message.repo';
import { logger } from '../../utils/logger';

const workspaceRepo = new WorkspaceRepo();
const channelRepo = new ChannelRepo();
const messageRepo = new MessageRepo();

/**
 * Handles all message.* MCP events dispatched from eventRouter.ts
 *
 * Strategy:
 *   message.created  → write directly to DB (single row, fast)
 *   message.updated  → update text/reactions in DB
 *   message.deleted  → soft-delete in DB
 *
 * For message.created we also enqueue a messageSync job so any
 * thread replies or attachments are captured asynchronously.
 */
export async function handleMessageEvent(event: MCPEvent): Promise<void> {
  const { workspaceId, type, payload } = event;

  // Resolve internal channel UUID from Slack channel ID
  const slackChannelId = payload['channel'] as string | undefined;
  if (!slackChannelId) {
    logger.warn({ workspaceId, type }, '[MessageHandler] Event missing channel ID — skipping');
    return;
  }

  const channelRecord = await channelRepo.findBySlackChannelId(workspaceId, slackChannelId);
  if (!channelRecord) {
    // Channel not yet synced — enqueue a channel sync first, then message sync
    logger.info(
      { workspaceId, slackChannelId },
      '[MessageHandler] Channel not in DB — enqueuing channel sync'
    );
    await getQueue(QUEUE_NAMES.CHANNEL_SYNC).add('event-triggered-channel-sync', {
      workspaceId,
    });
    await getQueue(QUEUE_NAMES.MESSAGE_SYNC).add(
      'event-triggered-message-sync',
      { workspaceId, channelId: slackChannelId },
      { delay: 5000 }
    );
    return;
  }

  if (type === 'message.created') {
    await _handleCreated(workspaceId, channelRecord.id, slackChannelId, payload);
  } else if (type === 'message.updated') {
    await _handleUpdated(workspaceId, channelRecord.id, payload);
  } else if (type === 'message.deleted') {
    await _handleDeleted(workspaceId, channelRecord.id, payload);
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function _handleCreated(
  workspaceId: string,
  channelId: string,
  slackChannelId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const ts = payload['ts'] as string | undefined;
  const userId = (payload['user'] ?? payload['bot_id'] ?? '') as string;
  const text = (payload['text'] ?? '') as string;
  const threadTs = payload['thread_ts'] as string | undefined;
  const subtype = payload['subtype'] as string | undefined;

  if (!ts) return;

  // Skip bot's own messages to prevent feedback loops
  // (bot_id check handles the case where our own bot posts)
  const workspace = await workspaceRepo.findById(workspaceId);
  if (workspace && userId === workspace.bot_user_id) {
    logger.debug({ workspaceId, ts }, '[MessageHandler] Skipping own bot message');
    return;
  }

  try {
    await messageRepo.upsert({
      workspace_id: workspaceId,
      channel_id: channelId,
      slack_ts: ts,
      slack_user_id: userId,
      text,
      subtype: subtype ?? null,
      thread_ts: threadTs ?? null,
      reply_count: 0,
      reactions: [],
      files: (payload['files'] ?? []) as unknown[],
      blocks: (payload['blocks'] ?? []) as unknown[],
      edited_at: null,
      slack_created_at: new Date(parseFloat(ts) * 1000).toISOString(),
    });

    logger.debug({ workspaceId, channelId, ts }, '[MessageHandler] Message created in DB');

    // If this is a threaded reply, enqueue a sync to capture the full thread
    if (threadTs && threadTs !== ts) {
      await getQueue(QUEUE_NAMES.MESSAGE_SYNC).add(
        'thread-sync',
        { workspaceId, channelId: slackChannelId },
        { delay: 2000, priority: 5 }
      );
    }
  } catch (err) {
    logger.error({ err, workspaceId, ts }, '[MessageHandler] Failed to write message.created');
    throw err;
  }
}

async function _handleUpdated(
  workspaceId: string,
  channelId: string,
  payload: Record<string, unknown>
): Promise<void> {
  // Slack wraps edited message in payload.message
  const updatedMsg = (payload['message'] ?? payload) as Record<string, unknown>;
  const ts = updatedMsg['ts'] as string | undefined;

  if (!ts) return;

  const editedRaw = updatedMsg['edited'] as Record<string, string> | undefined;

  try {
    await messageRepo.update(workspaceId, channelId, ts, {
      text: (updatedMsg['text'] ?? '') as string,
      edited_at: editedRaw?.ts
        ? new Date(parseFloat(editedRaw.ts) * 1000).toISOString()
        : new Date().toISOString(),
    });

    logger.debug({ workspaceId, channelId, ts }, '[MessageHandler] Message updated in DB');
  } catch (err) {
    logger.error({ err, workspaceId, ts }, '[MessageHandler] Failed to update message');
    throw err;
  }
}

async function _handleDeleted(
  workspaceId: string,
  channelId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const ts = (payload['deleted_ts'] ?? payload['ts']) as string | undefined;
  if (!ts) return;

  try {
    await messageRepo.markDeleted(workspaceId, channelId, ts);
    logger.debug({ workspaceId, channelId, ts }, '[MessageHandler] Message soft-deleted in DB');
  } catch (err) {
    logger.error({ err, workspaceId, ts }, '[MessageHandler] Failed to soft-delete message');
    throw err;
  }
}