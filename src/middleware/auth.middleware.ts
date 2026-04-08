import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Protects all internal Collectium API routes.
 *
 * Expects the API key in the Authorization header:
 *   Authorization: Bearer <COLLECTIUM_API_KEY>
 *
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * Apply this middleware in app.ts before mounting routes:
 *   app.use('/api/v1', authMiddleware, routes);
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    logger.warn({ ip: req.ip, path: req.path }, '[AuthMiddleware] Missing Authorization header');
    res.status(401).json({ ok: false, error: 'unauthorized', message: 'Missing Authorization header' });
    return;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({
      ok: false,
      error: 'unauthorized',
      message: 'Authorization header must use Bearer scheme',
    });
    return;
  }

  // Timing-safe comparison — prevents brute force timing attacks
  const expected = Buffer.from(env.COLLECTIUM_API_KEY, 'utf8');
  const received = Buffer.from(token, 'utf8');

  const isValid =
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);

  if (!isValid) {
    logger.warn({ ip: req.ip, path: req.path }, '[AuthMiddleware] Invalid API key');
    res.status(401).json({ ok: false, error: 'unauthorized', message: 'Invalid API key' });
    return;
  }

  next();
}