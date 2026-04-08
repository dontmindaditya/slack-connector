import type { Request, Response, NextFunction } from 'express';
import { WorkspaceRepo } from '../services/supabase/workspace.repo';
import { logger } from '../utils/logger';

const workspaceRepo = new WorkspaceRepo();

/**
 * Extracts workspaceId from the request and validates it exists
 * and is active in Supabase.
 *
 * workspaceId is read from (in order of priority):
 *   1. req.params.workspaceId    (route param: /api/v1/slack/auth/status/:workspaceId)
 *   2. X-Workspace-Id header     (preferred for all other routes)
 *   3. req.query.workspaceId     (fallback for debugging/tooling)
 *
 * On success: attaches `req.context = { workspaceId }` for downstream use.
 * On failure: returns 400 (missing) or 404 (not found / inactive).
 *
 * This middleware is the enforcement point for multi-tenancy.
 * Every service call downstream uses req.context.workspaceId —
 * data is never accessible without passing through this gate.
 */
export async function workspaceMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId =
      (req.params['workspaceId'] as string | undefined) ||
      (req.headers['x-workspace-id'] as string | undefined) ||
      (req.query['workspaceId'] as string | undefined);

    if (!workspaceId) {
      res.status(400).json({
        ok: false,
        error: 'missing_workspace_id',
        message: 'Provide workspaceId via X-Workspace-Id header, route param, or query string',
      });
      return;
    }

    // Validate against DB — also confirms it's active
    const workspace = await workspaceRepo.findById(workspaceId);

    if (!workspace) {
      res.status(404).json({
        ok: false,
        error: 'workspace_not_found',
        message: `Workspace ${workspaceId} not found`,
      });
      return;
    }

    if (!workspace.is_active) {
      res.status(403).json({
        ok: false,
        error: 'workspace_inactive',
        message: 'This workspace has been uninstalled or deactivated',
      });
      return;
    }

    // Attach context to request — used by all downstream controllers/services
    req.context = {
      workspaceId: workspace.id,
      requestId: req.headers['x-request-id'] as string | undefined,
    };

    logger.debug(
      { workspaceId: workspace.id, path: req.path },
      '[WorkspaceMiddleware] Context attached'
    );

    next();
  } catch (err) {
    next(err);
  }
}