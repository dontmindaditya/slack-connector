import type { Request, Response, NextFunction } from 'express';
import { registry } from '../mcp/registry';
import { ChannelRepo } from '../services/supabase/channel.repo';

const channelRepo = new ChannelRepo();

export class ChannelController {
  /**
   * GET /api/v1/slack/channels
   * Lists channels for a workspace.
   * Query params: includeArchived, limit, cursor
   * Source: Live Slack API (paginated)
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.context;
      const { cursor, limit, includeArchived } = req.query as Record<string, string>;

      const connector = registry.get('slack');
      const result = await connector.getChannels(
        { workspaceId },
        {
          cursor,
          limit: limit ? parseInt(limit, 10) : 100,
          includeArchived: includeArchived === 'true',
        }
      );

      res.json({
        ok: true,
        channels: result.channels,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/slack/channels/synced
   * Lists channels from Supabase (faster, no Slack API call).
   * Useful for internal Collectium reads.
   */
  listSynced = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.context;
      const { includeArchived, limit, offset } = req.query as Record<string, string>;

      const channels = await channelRepo.listByWorkspace(workspaceId, {
        includeArchived: includeArchived === 'true',
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });

      res.json({ ok: true, channels, count: channels.length });
    } catch (err) {
      next(err);
    }
  };
}