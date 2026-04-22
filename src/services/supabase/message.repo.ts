import { supabase } from '../../config/supabase';
import type { MessageRow, MessageInsert, MessageUpdate } from '../../types/supabase.types';
import { logger } from '../../utils/logger';

export class MessageRepo {
  private readonly TABLE = 'slack_messages' as const;

  /**
   * Find a message by Slack timestamp within a specific channel.
   * (workspace_id + channel_id + slack_ts) is the natural unique key.
   */
  async findByTs(
    workspaceId: string,
    channelId: string,
    slackTs: string
  ): Promise<MessageRow | null> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('channel_id', channelId)
      .eq('slack_ts', slackTs)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`[MessageRepo.findByTs] ${error.message}`);
    }

    return data;
  }

  /**
   * List messages for a channel with optional time-range and pagination.
   */
  async listByChannel(
    workspaceId: string,
    channelId: string,
    options: {
      limit?: number;
      offset?: number;
      before?: string;  
      after?: string;    
      threadTs?: string;
    } = {}
  ): Promise<MessageRow[]> {
    let query = supabase
      .from(this.TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('channel_id', channelId)
      .order('slack_created_at', { ascending: false });

    if (options.before) {
      query = query.lt('slack_created_at', options.before);
    }

    if (options.after) {
      query = query.gt('slack_created_at', options.after);
    }

    if (options.threadTs !== undefined) {
      query = query.eq('thread_ts', options.threadTs);
    }

    const limit = options.limit ?? 50;
    const from = options.offset ?? 0;
    query = query.range(from, from + limit - 1);

    const { data, error } = await query;

    if (error) {
      throw new Error(`[MessageRepo.listByChannel] ${error.message}`);
    }

    return data ?? [];
  }

  /**
   * Get the most recent message ts for a channel.
   * Used for incremental sync — only fetch messages newer than this.
   */
  async getLatestTs(workspaceId: string, channelId: string): Promise<string | null> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .select('slack_ts')
      .eq('workspace_id', workspaceId)
      .eq('channel_id', channelId)
      .order('slack_created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`[MessageRepo.getLatestTs] ${error.message}`);
    }

    return data?.slack_ts ?? null;
  }

  /**
   * Upsert a single message. Matches on (workspace_id, channel_id, slack_ts).
   */
  async upsert(payload: MessageInsert): Promise<MessageRow> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .upsert(
        { ...payload, updated_at: new Date().toISOString() },
        { onConflict: 'workspace_id,channel_id,slack_ts' }
      )
      .select()
      .single();

    if (error) {
      throw new Error(`[MessageRepo.upsert] ${error.message}`);
    }

    return data;
  }

  /**
   * Bulk upsert — the workhorse of message sync.
   * Writes up to 500 messages per call (Supabase limit).
   */
  async bulkUpsert(payloads: MessageInsert[]): Promise<number> {
    if (payloads.length === 0) return 0;

    // Supabase upsert batch limit is ~500 rows
    const BATCH_SIZE = 500;
    let totalInserted = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads
        .slice(i, i + BATCH_SIZE)
        .map((p) => ({ ...p, updated_at: now }));

      const { data, error } = await supabase
        .from(this.TABLE)
        .upsert(batch, { onConflict: 'workspace_id,channel_id,slack_ts' })
        .select('id');

      if (error) {
        throw new Error(`[MessageRepo.bulkUpsert] batch ${i}: ${error.message}`);
      }

      totalInserted += data?.length ?? 0;
    }

    logger.debug(
      { workspaceId: payloads[0]?.workspace_id, count: totalInserted },
      '[MessageRepo] Bulk upserted messages'
    );

    return totalInserted;
  }

  /**
   * Full-text search over message text using Postgres websearch syntax.
   * Requires the tsvector index defined in 001_slack_schema.sql.
   *
   * Supports websearch operators: AND (space), OR (|), NOT (-), phrase ("")
   * Example query: "standup notes" -bot
   */
  async search(
    workspaceId: string,
    query: string,
    options: {
      channelId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<MessageRow[]> {
    let q = supabase
      .from(this.TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .textSearch('text', query, { type: 'websearch', config: 'english' })
      .order('slack_created_at', { ascending: false });

    if (options.channelId) {
      q = q.eq('channel_id', options.channelId);
    }

    const limit = Math.min(options.limit ?? 50, 200);
    const from = options.offset ?? 0;
    q = q.range(from, from + limit - 1);

    const { data, error } = await q;

    if (error) {
      throw new Error(`[MessageRepo.search] ${error.message}`);
    }

    return data ?? [];
  }

  /**
   * Update a message (e.g. after receiving a message_changed event).
   */
  async update(
    workspaceId: string,
    channelId: string,
    slackTs: string,
    payload: MessageUpdate
  ): Promise<void> {
    const { error } = await supabase
      .from(this.TABLE)
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .eq('channel_id', channelId)
      .eq('slack_ts', slackTs);

    if (error) {
      throw new Error(`[MessageRepo.update] ${error.message}`);
    }
  }

  /**
   * Soft-delete: mark a message as deleted (set text to '', preserve record).
   */
  async markDeleted(workspaceId: string, channelId: string, slackTs: string): Promise<void> {
    const { error } = await supabase
      .from(this.TABLE)
      .update({
        text: '',
        subtype: 'message_deleted',
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_id', workspaceId)
      .eq('channel_id', channelId)
      .eq('slack_ts', slackTs);

    if (error) {
      throw new Error(`[MessageRepo.markDeleted] ${error.message}`);
    }
  }
}
