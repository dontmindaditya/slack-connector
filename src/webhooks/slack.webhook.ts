import type { Request, Response, NextFunction } from 'express';
import { registry } from '../mcp/registry';
import { dispatchEvent } from './eventRouter';
import { logger } from '../utils/logger';

/**
 * POST /webhooks/slack
 *
 * Entry point for all Slack Events API payloads.
 *
 * Responsibilities (in order):
 *   1. Respond to url_verification challenge (Slack's one-time handshake)
 *   2. Parse the raw body into a structured payload
 *   3. Delegate to connector.handleEvent() for normalization
 *   4. Dispatch the normalized MCPEvent to eventRouter
 *   5. Return HTTP 200 immediately — never block on async processing
 *
 * Note: Slack expects a 200 within 3 seconds.
 * Heavy processing (DB writes, Slack API calls) happens in handlers/jobs.
 */
export async function slackWebhookHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Body is parsed from rawBody by the time we get here
    const payload = req.body as Record<string, unknown>;

    // ── url_verification: Slack's one-time endpoint validation ───────────────
    if (payload['type'] === 'url_verification') {
      logger.info('[SlackWebhook] Responding to url_verification challenge');
      res.json({ challenge: payload['challenge'] });
      return;
    }

    // ── app_rate_limited: Slack telling us we've exceeded event delivery rate ─
    if (payload['type'] === 'app_rate_limited') {
      logger.warn(
        { teamId: payload['team_id'], minuteRateLimited: payload['minute_rate_limited'] },
        '[SlackWebhook] App rate limited by Slack'
      );
      res.status(200).json({ ok: true });
      return;
    }

    // ── Acknowledge immediately — Slack requires 200 within 3s ───────────────
    res.status(200).json({ ok: true });

    // ── Process asynchronously after response is sent ─────────────────────────
    setImmediate(async () => {
      try {
        const connector = registry.get('slack');

        // Normalize raw Slack payload → MCPEvent
        const event = await connector.handleEvent(payload);

        if (!event) {
          // null = url_verification, ignored event, or unknown workspace
          return;
        }

        // Dispatch to the correct handler
        await dispatchEvent(event);
      } catch (err) {
        // Never let async errors surface to Slack — we've already sent 200
        logger.error(
          { err: (err as Error).message, teamId: payload['team_id'] },
          '[SlackWebhook] Error during async event processing'
        );
      }
    });
  } catch (err) {
    next(err);
  }
}