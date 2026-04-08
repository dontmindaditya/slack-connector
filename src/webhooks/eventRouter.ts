import type { MCPEvent } from '../types/mcp.types';
import { handleMessageEvent } from './handlers/message.handler';
import { handleChannelEvent } from './handlers/channel.handler';
import { handleAppEvent } from './handlers/app.handler';
import { logger } from '../utils/logger';

/**
 * EventRouter — the central dispatcher for all inbound Slack events.
 *
 * Flow:
 *   slack.webhook.ts
 *     → verifySlackSignature  (rejects invalid/stale requests)
 *     → connector.handleEvent (normalizes Slack payload → MCPEvent)
 *     → eventRouter.dispatch  (routes MCPEvent to the right handler)
 *     → handler               (writes to DB or enqueues job)
 *
 * Adding a new event type:
 *   1. Add a case in the switch below
 *   2. Create or extend a handler in ./handlers/
 *   3. Done — slack.webhook.ts is never touched
 */
export async function dispatchEvent(event: MCPEvent): Promise<void> {
  const { type, workspaceId } = event;

  logger.debug({ type, workspaceId }, '[EventRouter] Dispatching event');

  switch (true) {
    // ── Message events ───────────────────────────────────────────────────────
    case type === 'message.created':
    case type === 'message.updated':
    case type === 'message.deleted':
      await handleMessageEvent(event);
      break;

    // ── Channel events ───────────────────────────────────────────────────────
    case type === 'channel.created':
    case type === 'channel.deleted':
    case type === 'member.joined':
    case type === 'member.left':
      await handleChannelEvent(event);
      break;

    // ── App lifecycle events ─────────────────────────────────────────────────
    case type === 'app.uninstalled':
    case type === 'tokens_revoked':
      await handleAppEvent(event);
      break;

    // ── Ignored events ───────────────────────────────────────────────────────
    default:
      logger.debug({ type, workspaceId }, '[EventRouter] No handler for event type — ignoring');
      break;
  }
}