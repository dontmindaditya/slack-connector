import type { Request, Response, NextFunction } from 'express';
import { registry } from '../mcp/registry';
import { getQueue, QUEUE_NAMES } from '../queue/bullmq';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export class AuthController {
  /**
   * GET /api/v1/slack/auth/install
   * Redirects the user to Slack's OAuth authorization page.
   */
  install = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const connector = registry.get('slack');
      const state = req.query['state'] as string | undefined;

      const installUrl = connector.getInstallUrl({ state });

      logger.info({ ip: req.ip }, '[AuthController] Redirecting to Slack install URL');
      res.redirect(installUrl);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/slack/auth/callback
   * Handles Slack's OAuth redirect with the authorization code.
   * Exchanges code → token, persists workspace, enqueues initial sync.
   */
  callback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { code, state, error } = req.query as Record<string, string>;

      if (error) {
        logger.warn({ error }, '[AuthController] OAuth denied by user');
        res.redirect(`${env.APP_BASE_URL}/slack/install/cancelled?reason=${error}`);
        return;
      }

      if (!code) {
        res.status(400).json({ ok: false, error: 'missing_code' });
        return;
      }

      const connector = registry.get('slack');
      const result = await connector.handleOAuthCallback({ code, state });

      // Enqueue initial channel + message sync for the newly installed workspace
      await getQueue(QUEUE_NAMES.CHANNEL_SYNC).add(
        'initial-channel-sync',
        { workspaceId: result.workspaceId, requestId: `install:${result.workspaceId}` },
        { delay: 2000 } // Small delay to let DB write settle
      );

      await getQueue(QUEUE_NAMES.MESSAGE_SYNC).add(
        'initial-message-sync',
        { workspaceId: result.workspaceId, fullSync: false, requestId: `install:${result.workspaceId}` },
        { delay: 10_000 } // After channels are synced
      );

      logger.info(
        { workspaceId: result.workspaceId },
        '[AuthController] OAuth install complete, sync enqueued'
      );

      res.redirect(result.redirectUrl ?? `${env.APP_BASE_URL}/slack/install/success`);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/slack/auth/status
   * Verifies the bot token for a workspace is still valid.
   */
  status = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.params as { workspaceId: string };

      const connector = registry.get('slack');
      const isValid = await connector.verifyConnection({ workspaceId });

      res.json({ ok: true, workspaceId, connected: isValid });
    } catch (err) {
      next(err);
    }
  };
}