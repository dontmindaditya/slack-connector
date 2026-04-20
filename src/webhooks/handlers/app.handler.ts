import type { MCPEvent } from '../../types/mcp.types';
import { registry } from '../../mcp/registry';
import { WorkspaceRepo } from '../../services/supabase/workspace.repo';
import { logger } from '../../utils/logger';

const workspaceRepo = new WorkspaceRepo();


export async function handleAppEvent(event: MCPEvent): Promise<void> {
  const { workspaceId, type } = event;

  switch (type) {
    case 'app.uninstalled':
      await _handleUninstalled(workspaceId);
      break;

    case 'tokens_revoked':
      await _handleTokensRevoked(workspaceId, event.payload);
      break;

    default:
      logger.debug({ type, workspaceId }, '[AppHandler] Unhandled app event type');
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function _handleUninstalled(workspaceId: string): Promise<void> {
  try {
    const connector = registry.get('slack');
    await connector.teardownWorkspace({ workspaceId });

    logger.info({ workspaceId }, '[AppHandler] Workspace uninstalled and torn down');
  } catch (err) {
    logger.error({ err, workspaceId }, '[AppHandler] Failed to tear down workspace');
    throw err;
  }
}

async function _handleTokensRevoked(
  workspaceId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const tokens = payload['tokens'] as Record<string, string[]> | undefined;
  const botTokens = tokens?.['bot'] ?? [];

  if (botTokens.length === 0) {
    // Only bot token revocation is our concern
    return;
  }

  logger.warn(
    { workspaceId, revokedCount: botTokens.length },
    '[AppHandler] Bot token(s) revoked — deactivating workspace'
  );

  try {
    await workspaceRepo.deactivate(workspaceId);
  } catch (err) {
    logger.error({ err, workspaceId }, '[AppHandler] Failed to deactivate workspace on token revocation');
    throw err;
  }
}
