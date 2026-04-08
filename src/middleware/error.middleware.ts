import type { Request, Response, NextFunction } from 'express';
import { ConnectorError } from '../types/mcp.types';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

/**
 * Global error handler — must be registered LAST in app.ts.
 * Catches all errors thrown by controllers, services, and middleware.
 *
 * Maps known error types to appropriate HTTP status codes.
 * Never leaks stack traces in production.
 */
export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // ── ConnectorError hierarchy ───────────────────────────────────────────────
  if (err instanceof ConnectorError) {
    logger.warn(
      { code: err.code, connectorId: err.connectorId, path: req.path },
      `[ErrorMiddleware] ConnectorError: ${err.message}`
    );
    res.status(err.statusCode).json({
      ok: false,
      error: err.code,
      message: err.message,
      connector: err.connectorId,
    });
    return;
  }

  // ── Zod validation errors ──────────────────────────────────────────────────
  if (err instanceof ZodError) {
    res.status(400).json({
      ok: false,
      error: 'validation_error',
      message: 'Request validation failed',
      details: err.flatten(),
    });
    return;
  }

  // ── Generic Error ──────────────────────────────────────────────────────────
  if (err instanceof Error) {
    const statusCode = _extractStatusCode(err) ?? 500;

    logger.error(
      {
        err: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
      },
      `[ErrorMiddleware] Unhandled error: ${err.message}`
    );

    res.status(statusCode).json({
      ok: false,
      error: statusCode >= 500 ? 'internal_server_error' : 'request_error',
      message:
        statusCode >= 500
          ? 'An unexpected error occurred'
          : err.message,
    });
    return;
  }

  // ── Unknown throw (string, object, etc.) ───────────────────────────────────
  logger.error({ err, path: req.path }, '[ErrorMiddleware] Unknown error type thrown');
  res.status(500).json({
    ok: false,
    error: 'internal_server_error',
    message: 'An unexpected error occurred',
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _extractStatusCode(err: Error): number | null {
  // Some libraries attach a statusCode or status field
  const candidate = (err as Error & { statusCode?: number; status?: number });
  return candidate.statusCode ?? candidate.status ?? null;
}