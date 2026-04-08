import type { Request, Response, NextFunction } from 'express';
import { registry } from '../mcp/registry';
import { MessageRepo } from '../services/supabase/message.repo';
import { z } from 'zod';

const messageRepo = new MessageRepo();

// ─── Validation schemas ───────────────────────────────────────────────────────

const searchQuerySchema = z.object({
  q: z.string().min(1, 'Search query must not be empty').max(500),
  channelId: z.string().optional(),
  limit: z.string().optional().transform((v) => (v ? Math.min(parseInt(v, 10), 200) : 50)),
  offset: z.string().optional().transform((v) => (v ? parseInt(v, 10) : 0)),
});

const sendMessageSchema = z.object({
  channelId: z.string().min(1),
  text: z.string().min(1).max(40_000),
  threadId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export class MessageController {
  /**
   * GET /api/v1/slack/messages/:channelId
   * Fetches messages live from Slack API.
   * Query: cursor, limit, before, after
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.context;
      const { channelId } = req.params as { channelId: string };
      const { cursor, limit, before, after } = req.query as Record<string, string>;

      const connector = registry.get('slack');
      const result = await connector.getMessages(
        { workspaceId },
        channelId,
        {
          cursor,
          limit: limit ? parseInt(limit, 10) : 50,
          before,
          after,
        }
      );

      res.json({
        ok: true,
        messages: result.messages,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/slack/messages/:channelId/synced
   * Reads messages from Supabase — no Slack API call.
   */
  listSynced = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.context;
      const { channelId } = req.params as { channelId: string };
      const { limit, offset, before, after, threadTs } = req.query as Record<string, string>;

      const messages = await messageRepo.listByChannel(workspaceId, channelId, {
        limit: limit ? parseInt(limit, 10) : 50,
        offset: offset ? parseInt(offset, 10) : 0,
        before,
        after,
        threadTs,
      });

      res.json({ ok: true, messages, count: messages.length });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/slack/messages/search
   * Full-text search over synced messages for a workspace.
   * Query: q (required), channelId?, limit?, offset?
   */
  search = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.context;

      const parsed = searchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: 'validation_error',
          details: parsed.error.flatten(),
        });
        return;
      }

      const { q, channelId, limit, offset } = parsed.data;

      const messages = await messageRepo.search(workspaceId, q, { channelId, limit, offset });

      res.json({ ok: true, messages, count: messages.length, query: q });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/slack/messages
   * Sends a message to a Slack channel.
   * Body: { channelId, text, threadId?, metadata? }
   */
  send = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workspaceId } = req.context;

      const parsed = sendMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: 'validation_error',
          details: parsed.error.flatten(),
        });
        return;
      }

      const { channelId, text, threadId, metadata } = parsed.data;

      const connector = registry.get('slack');
      const result = await connector.sendMessage(
        { workspaceId },
        { channelId, text, threadId, metadata }
      );

      res.status(201).json({ ok: true, message: result });
    } catch (err) {
      next(err);
    }
  };
}