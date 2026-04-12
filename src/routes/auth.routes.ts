import { Router, type Request, type Response, type NextFunction } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { workspaceMiddleware } from '../middleware/workspace.middleware';
import rateLimit from 'express-rate-limit';

const router = Router();
const controller = new AuthController();


const oauthRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `oauth:${req.ip}`,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      ok: false,
      error: 'too_many_requests',
      message: 'Too many OAuth attempts. Please wait 15 minutes before trying again.',
    });
  },
});

// ─── Param validation middleware ──────────────────────────────────────────────

function validateWorkspaceIdParam(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { workspaceId } = req.params;

  if (!workspaceId || typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    res.status(400).json({
      ok: false,
      error: 'invalid_param',
      message: 'workspaceId param is required and must be a non-empty string',
    });
    return;
  }

  // Must be a valid UUID (our internal workspace ID format)
  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!UUID_REGEX.test(workspaceId)) {
    res.status(400).json({
      ok: false,
      error: 'invalid_param',
      message: 'workspaceId must be a valid UUID',
    });
    return;
  }

  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/slack/auth/install
 *
 * Redirects the browser to Slack's OAuth authorization page.
 *
 * Query params:
 *   state? (string) — Optional CSRF state token. If omitted, one is generated.
 *
 * Response: 302 redirect → https://slack.com/oauth/v2/authorize?...
 *
 * Example:
 *   GET /api/v1/slack/auth/install
 *   GET /api/v1/slack/auth/install?state=my-csrf-token
 */
router.get('/install', oauthRateLimit, controller.install);

/**
 * GET /api/v1/slack/auth/callback
 *
 * Handles Slack's OAuth redirect after the user authorizes the app.
 * Exchanges the one-time code for a bot token, persists the workspace,
 * and enqueues the initial channel + message sync jobs.
 *
 * Query params (set by Slack):
 *   code    (string) — One-time authorization code
 *   state?  (string) — CSRF state echoed back from the install redirect
 *   error?  (string) — Set if user denied the OAuth request (e.g. "access_denied")
 *
 * Responses:
 *   302 → APP_BASE_URL/slack/install/success  (on success)
 *   302 → APP_BASE_URL/slack/install/cancelled (on user denial)
 *   400 — missing_code if code param is absent
 *
 * Example (Slack calls this automatically after user clicks "Allow"):
 *   GET /api/v1/slack/auth/callback?code=abc123&state=my-csrf-token
 */
router.get('/callback', oauthRateLimit, controller.callback);

/**
 * GET /api/v1/slack/auth/status/:workspaceId
 *
 * Verifies that the stored bot token for a workspace is still valid.
 * Calls Slack's auth.test endpoint under the hood.
 *
 * Path params:
 *   workspaceId (UUID) — Internal workspace UUID from slack_workspaces.id
 *
 * Headers:
 *   Authorization: Bearer <COLLECTIUM_API_KEY>  (required — applied at router level in app.ts)
 *   X-Workspace-Id: <workspaceId>               (alternative to path param)
 *
 * Responses:
 *   200 { ok: true, workspaceId, connected: true }   — token valid
 *   200 { ok: true, workspaceId, connected: false }  — token invalid/revoked
 *   400 — invalid_param if workspaceId is not a UUID
 *   404 — workspace_not_found if workspace doesn't exist or is inactive
 *
 * Example:
 *   GET /api/v1/slack/auth/status/550e8400-e29b-41d4-a716-446655440000
 */
router.get(
  '/status/:workspaceId',
  validateWorkspaceIdParam,
  workspaceMiddleware,
  controller.status
);

export default router;
