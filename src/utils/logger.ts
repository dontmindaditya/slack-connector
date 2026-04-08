import pino from 'pino';
import { env, IS_PRODUCTION } from '../config/env';

/**
 * Structured logger using Pino.
 *
 * Production: JSON output (machine-readable, ingested by log aggregators)
 * Development: Pretty-printed with colors (human-readable)
 *
 * Usage:
 *   import { logger } from '../utils/logger';
 *   logger.info({ workspaceId }, 'Message synced');
 *   logger.error({ err, channelId }, 'Sync failed');
 */
export const logger = pino({
  level: IS_PRODUCTION ? 'info' : 'debug',

  // Pretty print in development
  ...(IS_PRODUCTION
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),

  // Base fields included on every log line
  base: {
    env: env.NODE_ENV,
    service: 'collectium-slack-connector',
  },

  // Redact sensitive fields from logs — never log tokens
  redact: {
    paths: [
      'bot_token',
      'access_token',
      '*.bot_token',
      '*.access_token',
      'authorization',
      'headers.authorization',
      'req.headers.authorization',
    ],
    censor: '[REDACTED]',
  },

  // Serialize errors properly
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },

  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Creates a child logger with a persistent requestId field.
 * Use this in request handlers for end-to-end trace correlation.
 *
 * const reqLogger = childLogger(requestId);
 * reqLogger.info('Processing event');
 */
export function childLogger(requestId: string): pino.Logger {
  return logger.child({ requestId });
}