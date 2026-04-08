import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger';

/**
 * Standard rate limiter for all /api/v1/* routes.
 * 300 requests per minute per IP address.
 */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 300,
  standardHeaders: true,   // Return RateLimit-* headers
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    // Use API key as rate limit key if present, else fall back to IP
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      // Hash the key so it's not logged raw
      return `key:${authHeader.slice(7, 15)}`;
    }
    return `ip:${req.ip}`;
  },
  handler: (req: Request, res: Response) => {
    logger.warn(
      { ip: req.ip, path: req.path },
      '[RateLimit] API rate limit exceeded'
    );
    res.status(429).json({
      ok: false,
      error: 'rate_limit_exceeded',
      message: 'Too many requests. Please wait before retrying.',
      retryAfter: Math.ceil(60),
    });
  },
});

/**
 * Stricter rate limiter for sync trigger endpoints.
 * 10 sync requests per minute per workspace.
 */
export const syncRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    // Key per workspace, not per IP
    const workspaceId =
      req.context?.workspaceId ||
      (req.headers['x-workspace-id'] as string) ||
      req.ip;
    return `sync:${workspaceId}`;
  },
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      ok: false,
      error: 'sync_rate_limit_exceeded',
      message: 'Too many sync requests. Max 10 sync triggers per minute per workspace.',
    });
  },
});

/**
 * Webhook rate limiter — generous, since Slack itself sends events.
 * Prevents abuse if the endpoint is somehow hit directly.
 */
export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `webhook:${req.ip}`,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ ok: false, error: 'webhook_rate_limit_exceeded' });
  },
});