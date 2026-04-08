import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const SLACK_SIGNATURE_VERSION = 'v0';
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Verifies that an inbound request genuinely came from Slack.
 *
 * Slack signs every webhook request using HMAC-SHA256 with your app's
 * signing secret. We recompute the signature and compare it to the one
 * in the X-Slack-Signature header using a timing-safe comparison.
 *
 * Requests older than 5 minutes are rejected to prevent replay attacks.
 *
 * IMPORTANT: This middleware must run BEFORE body parsing (json middleware)
 * because we need the raw request body for signature computation.
 * app.ts registers this on /webhooks/slack with express.raw().
 */
export function verifySlackSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const timestamp = req.headers['x-slack-request-timestamp'] as string;
    const slackSignature = req.headers['x-slack-signature'] as string;

    // ── 1. Validate required headers ─────────────────────────────────────────
    if (!timestamp || !slackSignature) {
      logger.warn(
        { ip: req.ip, path: req.path },
        '[VerifySignature] Missing Slack signature headers'
      );
      res.status(400).json({ ok: false, error: 'missing_signature_headers' });
      return;
    }

    // ── 2. Replay attack protection — reject stale requests ──────────────────
    const requestAgeMs = Date.now() - parseInt(timestamp, 10) * 1000;
    if (requestAgeMs > FIVE_MINUTES_MS) {
      logger.warn(
        { ip: req.ip, ageMs: requestAgeMs },
        '[VerifySignature] Request timestamp too old — possible replay attack'
      );
      res.status(400).json({ ok: false, error: 'stale_request' });
      return;
    }

    // ── 3. Compute expected signature ─────────────────────────────────────────
    // Slack sends the raw body, we need it as a string
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      logger.error('[VerifySignature] rawBody not available — ensure express.raw() is used');
      res.status(500).json({ ok: false, error: 'server_configuration_error' });
      return;
    }

    const sigBaseString = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody.toString('utf8')}`;

    const expectedSignature =
      SLACK_SIGNATURE_VERSION +
      '=' +
      crypto
        .createHmac('sha256', env.SLACK_SIGNING_SECRET)
        .update(sigBaseString, 'utf8')
        .digest('hex');

    // ── 4. Timing-safe comparison ─────────────────────────────────────────────
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(slackSignature, 'utf8');

    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      logger.warn(
        { ip: req.ip, path: req.path },
        '[VerifySignature] Signature mismatch — request rejected'
      );
      res.status(401).json({ ok: false, error: 'invalid_signature' });
      return;
    }

    next();
  } catch (err) {
    logger.error({ err }, '[VerifySignature] Unexpected error during signature verification');
    next(err);
  }
}