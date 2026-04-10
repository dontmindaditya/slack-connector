import { Worker, Job } from 'bullmq';
import {
  QUEUE_NAMES,
  redisConnection,
  type ChannelSyncJobData,
} from '../bullmq';
import { ChannelSyncService } from '../../services/sync/channel.sync';
import { logger } from '../../utils/logger';

const channelSyncService = new ChannelSyncService();

export function createChannelSyncWorker(): Worker<ChannelSyncJobData> {
  const worker = new Worker<ChannelSyncJobData>(
    QUEUE_NAMES.CHANNEL_SYNC,
    async (job: Job<ChannelSyncJobData>) => {
      const { workspaceId, requestId } = job.data;

      logger.info(
        { jobId: job.id, workspaceId, requestId },
        '[ChannelSyncJob] Starting'
      );

      const result = await channelSyncService.syncChannels(workspaceId);

      logger.info(
        { jobId: job.id, workspaceId, synced: result.synced, errors: result.errors.length },
        '[ChannelSyncJob] Complete'
      );

      if (result.errors.length > 0) {
        logger.warn(
          { jobId: job.id, errors: result.errors },
          '[ChannelSyncJob] Completed with errors'
        );
      }

      return result;
    },
    {
      connection: redisConnection,
      concurrency: 5,
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, '[ChannelSyncJob] Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message, attempts: job?.attemptsMade },
      '[ChannelSyncJob] Job failed'
    );
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, '[ChannelSyncJob] Worker error');
  });

  logger.info('[ChannelSyncJob] Worker started');
  return worker;
}
