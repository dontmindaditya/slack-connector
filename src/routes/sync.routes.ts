import { Router } from 'express';
import { SyncController } from '../controllers/sync.controller';
import { workspaceMiddleware } from '../middleware/workspace.middleware';

const router = Router();
const controller = new SyncController();

// Sync triggers require workspace context
router.post('/messages', workspaceMiddleware, controller.triggerMessageSync);
router.post('/channels', workspaceMiddleware, controller.triggerChannelSync);

// Job status does not need workspace context — job ID is globally unique
router.get('/status/:jobId', controller.jobStatus);

export default router;