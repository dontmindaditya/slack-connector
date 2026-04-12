import { Router, type Request, type Response, type NextFunction } from 'express';
import { ChannelController } from '../controllers/channel.controller';
import { workspaceMiddleware } from '../middleware/workspace.middleware';

const router = Router();
const controller = new ChannelController();



function validateListQueryParams(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { limit, offset } = req.query as Record<string, string | undefined>;

  if (limit !== undefined) {
    const parsed = parseInt(limit, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 200) {
      res.status(400).json({
        ok: false,
        error: 'invalid_param',
        message: 'limit must be an integer between 1 and 200',
      });
      return;
    }
  }

  if (offset !== undefined) {
    const parsed = parseInt(offset, 10);
    if (isNaN(parsed) || parsed < 0) {
      res.status(400).json({
        ok: false,
        error: 'invalid_param',
        message: 'offset must be a non-negative integer',
      });
      return;
    }
  }

  next();
}

// ─── All channel routes require workspace context ─────────────────────────────
// workspaceMiddleware reads X-Workspace-Id header (or ?workspaceId query param),
// validates it against Supabase, and attaches req.context.workspaceId.
// Every controller below is guaranteed a valid, active workspaceId.

router.use(workspaceMiddleware);

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/slack/channels
 *
 * Lists channels for the workspace by calling the Slack API live.
 * Use this when you need guaranteed fresh data (e.g. first load, after install).
 * Supports cursor-based pagination — pass nextCursor from a previous response
 * as the cursor param to get the next page.
 *
 * Headers:
 *   Authorization: Bearer <COLLECTIUM_API_KEY>   (required)
 *   X-Workspace-Id: <workspaceId>                (required)
 *
 * Query params:
 *   cursor?          (string)  — Cursor from a previous response for pagination
 *   limit?           (int)     — Results per page, 1–200 (default: 100)
 *   includeArchived? (boolean) — Include archived channels (default: false)
 *
 * Response 200:
 *   {
 *     ok: true,
 *     channels: MCPChannel[],
 *     nextCursor: string | undefined,
 *     hasMore: boolean
 *   }
 *
 * Example:
 *   GET /api/v1/slack/channels?limit=50
 *   GET /api/v1/slack/channels?cursor=dXNlcjp...&limit=50
 *   GET /api/v1/slack/channels?includeArchived=true
 */
router.get('/', validateListQueryParams, controller.list);

/**
 * GET /api/v1/slack/channels/synced
 *
 * Lists channels from Supabase — no Slack API call, always fast.
 * Use this for all routine reads inside Collectium.
 * Data freshness depends on the last channel sync job run.
 *
 * Headers:
 *   Authorization: Bearer <COLLECTIUM_API_KEY>   (required)
 *   X-Workspace-Id: <workspaceId>                (required)
 *
 * Query params:
 *   includeArchived? (boolean) — Include archived channels (default: false)
 *   limit?           (int)     — Max rows to return (default: all)
 *   offset?          (int)     — Rows to skip for pagination (default: 0)
 *
 * Response 200:
 *   {
 *     ok: true,
 *     channels: ChannelRow[],
 *     count: number
 *   }
 *
 * Example:
 *   GET /api/v1/slack/channels/synced
 *   GET /api/v1/slack/channels/synced?limit=20&offset=40
 *   GET /api/v1/slack/channels/synced?includeArchived=true
 */
router.get('/synced', validateListQueryParams, controller.listSynced);

export default router;
