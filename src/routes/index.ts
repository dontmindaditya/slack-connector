import { Router, type Request, type Response } from 'express';
import authRoutes from './auth.routes';
import channelRoutes from './channel.routes';
import messageRoutes from './message.routes';
import syncRoutes from './sync.routes';
import { registry } from '../mcp/registry';

const router = Router();


router.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    connectors: registry.getAllMeta().map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      capabilities: m.capabilities,
    })),
  });
});

// ─── Slack API routes ─────────────────────────────────────────────────────────

router.use('/slack/auth', authRoutes);
router.use('/slack/channels', channelRoutes);
router.use('/slack/messages', messageRoutes);
router.use('/slack/sync', syncRoutes);

export default router;
