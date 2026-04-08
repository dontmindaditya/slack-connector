/**
 * Worker process entry point.
 *
 * This runs as a SEPARATE process from index.ts (the HTTP server).
 * It starts all BullMQ workers AND the periodic sync scheduler.
 *
 * In production, run both:
 *   node dist/index.js    ← HTTP server
 *   node dist/worker.js   ← Job processor + scheduler
 *
 * In docker-compose, these are separate services sharing the same Redis.
 */

import { startWorkers, stopWorkers } from './src/queue/worker';
import { startScheduler, type Scheduler } from './src/scheduler';
import { logger } from './src/utils/logger';

async function main(): Promise<void> {
  logger.info('[WorkerProcess] Starting BullMQ workers...');

  startWorkers();

  logger.info('[WorkerProcess] All workers running — waiting for jobs');

  // Start periodic sync scheduler (channel sync every 60 min, message sync every 15 min)
  const scheduler: Scheduler = startScheduler();

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '[WorkerProcess] Shutdown signal received');

    scheduler.stop();

    // stopWorkers() waits for active jobs to finish before closing
    await stopWorkers();

    logger.info('[WorkerProcess] Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, '[WorkerProcess] Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, '[WorkerProcess] Uncaught exception — shutting down');
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Fatal worker startup error:', err);
  process.exit(1);
});