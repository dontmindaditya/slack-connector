import { Worker, Job } from 'bullmq';
import {
  QUEUE_NAMES,
  redisConnection,
  type MessageSyncJobData,
} from '../bullmq';
import { MessageSyncService } from '../../services/sync/message.sync';
import { logger } from '../../utils/logger';

const messageSyncService = new MessageSyncService();

/**
 * Processes slack:message-sync jobs.
 * Enqueued by:
 *   - message.handler.ts (on every incoming Slack message event)
 *   - sync.controller.ts (on manual sync trigger)
 *   - Scheduled job runner (periodic full sync)
 */
export function createMessageSyncWorker(): Worker<MessageSyncJobData> {
  const worker = new Worker<MessageSyncJobData>(
    QUEUE_NAMES.MESSAGE_SYNC,
    async (job: Job<MessageSyncJobData>) => {
      const { workspaceId, channelId, since, fullSync, limit, requestId } = job.data;

      logger.info(
        { jobId: job.id, workspaceId, channelId, requestId },
        '[MessageSyncJob] Starting'
      );

      const result = await messageSyncService.syncMessages(workspaceId, {
        channelId,
        since: since ? new Date(since) : undefined,
        fullSync,
        limit,
      });

      logger.info(
        {
          jobId: job.id,
          workspaceId,
          channelId,
          synced: result.synced,
          usersDiscovered: result.usersDiscovered,
          errors: result.errors.length,
        },
        '[MessageSyncJob] Complete'
      );

      // If there were partial errors, log them but don't fail the job
      // (individual channel errors are non-fatal)
      if (result.errors.length > 0) {
        logger.warn(
          { jobId: job.id, errors: result.errors },
          '[MessageSyncJob] Completed with partial errors'
        );
      }

      return result;
    },
    {
      connection: redisConnection,
      concurrency: 3,           // Process 3 sync jobs in parallel
      limiter: {
        max: 10,                // Max 10 jobs per duration
        duration: 60_000,       // Per minute — respect Slack rate limits
      },
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, '[MessageSyncJob] Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message, attempts: job?.attemptsMade },
      '[MessageSyncJob] Job failed'
    );
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, '[MessageSyncJob] Worker error');
  });

  logger.info('[MessageSyncJob] Worker started');
  return worker;
}