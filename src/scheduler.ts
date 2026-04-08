import { getQueue, QUEUE_NAMES } from './queue/bullmq';
import { WorkspaceRepo } from './services/supabase/workspace.repo';
import { logger } from './utils/logger';

const CHANNEL_SYNC_INTERVAL_MS = 60 * 60 * 1000;   // Every 60 minutes
const MESSAGE_SYNC_INTERVAL_MS = 15 * 60 * 1000;   // Every 15 minutes

export interface Scheduler {
  stop(): void;
}

/**
 * Starts periodic sync jobs for all active workspaces.
 *
 * Design:
 *   - Uses setInterval rather than BullMQ repeatable jobs so the fan-out logic
 *     (query all workspaces → enqueue one job per workspace) stays in TypeScript
 *     rather than being pushed into a single-workspace job that has to bootstrap itself.
 *   - Jobs are enqueued with a stable `jobId` (`scheduled-*:<workspaceId>`) so BullMQ
 *     deduplicates them: if a previous run's job is still waiting/active when the next
 *     tick fires, the duplicate is silently dropped.
 *   - Runs in the worker process (worker.ts) to keep the HTTP server stateless.
 *
 * To stop: call scheduler.stop() in the SIGTERM/SIGINT handler.
 */
export function startScheduler(): Scheduler {
  const workspaceRepo = new WorkspaceRepo();

  // ── Channel sync fan-out ────────────────────────────────────────────────────

  async function runChannelSync(): Promise<void> {
    try {
      const workspaces = await workspaceRepo.listActive();
      if (workspaces.length === 0) return;

      const queue = getQueue(QUEUE_NAMES.CHANNEL_SYNC);
      await Promise.allSettled(
        workspaces.map((ws) =>
          queue.add(
            'scheduled-channel-sync',
            { workspaceId: ws.id, requestId: `scheduler:channel:${ws.id}` },
            { jobId: `scheduled-channel-sync:${ws.id}` }  // deduplication key
          )
        )
      );

      logger.info(
        { workspaceCount: workspaces.length },
        '[Scheduler] Channel sync jobs enqueued'
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[Scheduler] Channel sync fan-out failed');
    }
  }

  // ── Message sync fan-out ────────────────────────────────────────────────────

  async function runMessageSync(): Promise<void> {
    try {
      const workspaces = await workspaceRepo.listActive();
      if (workspaces.length === 0) return;

      const queue = getQueue(QUEUE_NAMES.MESSAGE_SYNC);
      await Promise.allSettled(
        workspaces.map((ws) =>
          queue.add(
            'scheduled-message-sync',
            {
              workspaceId: ws.id,
              fullSync: false,   // Always incremental — full syncs are manual only
              requestId: `scheduler:message:${ws.id}`,
            },
            { jobId: `scheduled-message-sync:${ws.id}` }  // deduplication key
          )
        )
      );

      logger.info(
        { workspaceCount: workspaces.length },
        '[Scheduler] Message sync jobs enqueued'
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[Scheduler] Message sync fan-out failed');
    }
  }

  // ── Start ───────────────────────────────────────────────────────────────────

  // Run immediately on startup so there's no gap on first deploy
  void runChannelSync();
  void runMessageSync();

  const channelTimer = setInterval(() => void runChannelSync(), CHANNEL_SYNC_INTERVAL_MS);
  const messageTimer = setInterval(() => void runMessageSync(), MESSAGE_SYNC_INTERVAL_MS);

  logger.info(
    {
      channelSyncEveryMs: CHANNEL_SYNC_INTERVAL_MS,
      messageSyncEveryMs: MESSAGE_SYNC_INTERVAL_MS,
    },
    '[Scheduler] Periodic sync scheduler started'
  );

  return {
    stop(): void {
      clearInterval(channelTimer);
      clearInterval(messageTimer);
      logger.info('[Scheduler] Scheduler stopped');
    },
  };
}
