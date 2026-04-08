import { createApp, bootstrap } from './src/app';
import { env } from './src/config/env';
import { logger } from './src/utils/logger';
import { closeAllQueues } from './src/queue/bullmq';

async function main(): Promise<void> {
  // Bootstrap connectors (register Slack, future Discord, etc.)
  bootstrap();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV },
      `🚀 Collectium Slack Connector running on port ${env.PORT}`
    );
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '[Server] Shutdown signal received');

    // Stop accepting new connections
    server.close(async () => {
      logger.info('[Server] HTTP server closed');

      // Close BullMQ queue connections
      await closeAllQueues();

      logger.info('[Server] Graceful shutdown complete');
      process.exit(0);
    });

    // Force shutdown after 15s if graceful fails
    setTimeout(() => {
      logger.error('[Server] Forced shutdown after 15s timeout');
      process.exit(1);
    }, 15_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, '[Server] Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, '[Server] Uncaught exception — shutting down');
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});