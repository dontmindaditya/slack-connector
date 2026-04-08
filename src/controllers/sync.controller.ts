import type { Request, Response, NextFunction } from 'express';
import { getQueue, QUEUE_NAMES } from '../queue/bullmq';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

const triggerSyncSchema = z.object({
  channelId: z.string().optional(),
  since: z.string().datetime().optional(),
  fullSync: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(10_000).optional(),
});

export class SyncController {
  /**
   * POST /api/v1/slack/sync/messages
   * Enqueues a message sync job for a workspace.
   * Body: { channelId?, since?, fullSync?, limit? }
   */
  triggerMessageSync = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.context;

      const parsed = triggerSyncSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: 'validation_error',
          details: parsed.error.flatten(),
        });
        return;
      }

      const requestId = uuidv4();

      const job = await getQueue(QUEUE_NAMES.MESSAGE_SYNC).add(
        'manual-message-sync',
        {
          workspaceId,
          ...parsed.data,
          since: parsed.data.since,
          requestId,
        },
        { priority: 1 }  // Manual triggers get higher priority
      );

      res.status(202).json({
        ok: true,
        jobId: job.id,
        requestId,
        message: 'Message sync enqueued',
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/slack/sync/channels
   * Enqueues a channel list sync job for a workspace.
   */
  triggerChannelSync = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.context;
      const requestId = uuidv4();

      const job = await getQueue(QUEUE_NAMES.CHANNEL_SYNC).add(
        'manual-channel-sync',
        { workspaceId, requestId },
        { priority: 1 }
      );

      res.status(202).json({
        ok: true,
        jobId: job.id,
        requestId,
        message: 'Channel sync enqueued',
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/slack/sync/status/:jobId
   * Returns status of a sync job.
   */
  jobStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { jobId } = req.params as { jobId: string };

      // Check both queues
      const msgQueue = getQueue(QUEUE_NAMES.MESSAGE_SYNC);
      const chQueue = getQueue(QUEUE_NAMES.CHANNEL_SYNC);

      let job = await msgQueue.getJob(jobId);
      if (!job) job = await chQueue.getJob(jobId);

      if (!job) {
        res.status(404).json({ ok: false, error: 'job_not_found' });
        return;
      }

      const state = await job.getState();
      const progress = job.progress;

      res.json({
        ok: true,
        jobId,
        state,
        progress,
        returnValue: state === 'completed' ? job.returnvalue : undefined,
        failedReason: state === 'failed' ? job.failedReason : undefined,
        timestamp: {
          created: job.timestamp,
          processed: job.processedOn,
          finished: job.finishedOn,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}