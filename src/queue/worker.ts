import { Worker } from 'bullmq';
import { createMessageSyncWorker } from './jobs/messageSync.job';
import { createChannelSyncWorker } from './jobs/channelSync.job';
import { logger } from '../utils/logger';

let workers: Worker[] = [];

/**
 * Starts all BullMQ workers.
 * Called from the worker entry point (worker.ts at project root).
 * Each worker runs in this process — separate from the HTTP server.
 */
export function startWorkers(): void {
  workers = [
    createMessageSyncWorker(),
    createChannelSyncWorker(),
  ];

  logger.info({ count: workers.length }, '[Workers] All workers started');
}

/**
 * Gracefully stops all workers — waits for active jobs to complete.
 * Call this in SIGTERM/SIGINT handlers.
 */
export async function stopWorkers(): Promise<void> {
  logger.info('[Workers] Stopping all workers...');
  await Promise.allSettled(workers.map((w) => w.close()));
  workers = [];
  logger.info('[Workers] All workers stopped');
}