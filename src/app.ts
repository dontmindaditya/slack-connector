import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env, IS_PRODUCTION } from './config/env';
import routes from './routes/index';
import { slackWebhookHandler } from './webhooks/slack.webhook';
import { verifySlackSignature } from './webhooks/middleware/verify-signature';
import { authMiddleware } from './middleware/auth.middleware';
import { apiRateLimit, webhookRateLimit } from './middleware/rate-limit.middleware';
import { errorMiddleware } from './middleware/error.middleware';
import { bootstrapConnectors } from './mcp/registry';
import { logger } from './utils/logger';
import { supabase } from './config/supabase';
import { getQueue, QUEUE_NAMES } from './queue/bullmq';

// ─── Type augmentation ────────────────────────────────────────────────────────
// Extend Express Request with our custom context and rawBody

declare global {
  namespace Express {
    interface Request {
      context: {
        workspaceId: string;
        requestId?: string;
        callerUserId?: string;
      };
      rawBody?: Buffer;
    }
  }
}

export function createApp(): express.Application {
  const app = express();

  // ── 1. Security headers ────────────────────────────────────────────────────
  app.use(helmet());

  app.use(
    cors({
      origin: IS_PRODUCTION ? env.APP_BASE_URL : '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Workspace-Id',
        'X-Request-Id',
      ],
    })
  );

  // ── 2. Trust proxy (for accurate IP in rate limiting behind load balancer) ─
  if (IS_PRODUCTION) {
    app.set('trust proxy', 1);
  }

  // ── 3. Webhook route — raw body + signature verification ──────────────────
  // MUST be registered BEFORE express.json() so rawBody is available.
  // We capture the raw Buffer and attach it to req.rawBody for HMAC verification.
  app.post(
    '/webhooks/slack',
    webhookRateLimit,
    express.raw({ type: 'application/json' }),
    (req: Request, _res, next) => {
      // Attach raw body for signature verification
      req.rawBody = req.body as Buffer;
      // Parse body so handlers can read it as JSON
      try {
        req.body = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        req.body = {};
      }
      next();
    },
    verifySlackSignature,
    slackWebhookHandler
  );

  // ── 4. JSON body parsing for all other routes ─────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── 5. Request ID injection ────────────────────────────────────────────────
  app.use((req: Request, _res, next) => {
    if (!req.headers['x-request-id']) {
      req.headers['x-request-id'] = crypto.randomUUID();
    }
    next();
  });

  // ── 6. Request logging ─────────────────────────────────────────────────────
  app.use((req: Request, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
        requestId: req.headers['x-request-id'],
      }, 'Request');
    });
    next();
  });

  // ── 7. Internal API routes — protected by API key + rate limit ─────────────
  app.use('/api/v1', apiRateLimit, authMiddleware, routes);

  // ── 8. Root health check (unauthenticated) ────────────────────────────────
  app.get('/health', async (_req: Request, res: Response) => {
    const checks: Record<string, 'ok' | 'error'> = {};

    // Supabase reachability — a lightweight count query
    try {
      const { error } = await supabase
        .from('slack_workspaces')
        .select('id', { count: 'exact', head: true });
      checks.supabase = !error ? 'ok' : 'error';
    } catch {
      checks.supabase = 'error';
    }

    // Redis reachability — BullMQ getJobCounts requires an active connection
    try {
      await getQueue(QUEUE_NAMES.CHANNEL_SYNC).getJobCounts('active', 'waiting');
      checks.redis = 'ok';
    } catch {
      checks.redis = 'error';
    }

    const healthy = Object.values(checks).every((v) => v === 'ok');

    res.status(healthy ? 200 : 503).json({
      ok: healthy,
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  // ── 9. 404 handler ─────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // ── 10. Global error handler — must be last ────────────────────────────────
  app.use(errorMiddleware);

  return app;
}

/**
 * Bootstrap all MCP connectors.
 * Called once before the server starts listening.
 */
export function bootstrap(): void {
  bootstrapConnectors();
  logger.info('[App] Bootstrap complete');
}