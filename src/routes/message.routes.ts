import { Router } from 'express';
import { MessageController } from '../controllers/message.controller';
import { workspaceMiddleware } from '../middleware/workspace.middleware';

const router = Router();
const controller = new MessageController();

// All message routes require workspace context
router.use(workspaceMiddleware);

// Full-text search — MUST be registered before /:channelId to avoid route shadowing
router.get('/search', controller.search);

// Live Slack API reads
router.get('/:channelId', controller.list);

// Supabase reads (faster, no Slack API call)
router.get('/:channelId/synced', controller.listSynced);

// Send a message
router.post('/', controller.send);

export default router;