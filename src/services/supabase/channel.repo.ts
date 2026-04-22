import { supabase } from '../../config/supabase';
import type { ChannelRow, ChannelInsert, ChannelUpdate } from '../../types/supabase.types';
import { logger } from '../../utils/logger';

export class ChannelRepo {
  private readonly TABLE = 'slack_channels' as const;

  /**
 
   * Always scoped to workspaceId to enforce multi-tenancy.
   */
  async findById(workspaceId: string, id: string): Promise<ChannelRow | null> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .select('*')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`[ChannelRepo.findById] ${error.message}`);
    }

    return data;
  }

  /**
   * Find a channel by its Slack channel ID (e.g. "C01234ABC").
   */
  async findBySlackChannelId(
    workspaceId: string,
    slackChannelId: string
  ): Promise<ChannelRow | null> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('slack_channel_id', slackChannelId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`[ChannelRepo.findBySlackChannelId] ${error.message}`);
    }

    return data;
  }

  /**
   * List all channels for a workspace with optional filters.
   */
  async listByWorkspace(
    workspaceId: string,
    options: { includeArchived?: boolean; limit?: number; offset?: number } = {}
  ): Promise<ChannelRow[]> {
    let query = supabase
      .from(this.TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('name', { ascending: true });

    if (!options.includeArchived) {
      query = query.eq('is_archived', false);
    }

    if (options.limit) {
      const from = options.offset ?? 0;
      query = query.range(from, from + options.limit - 1);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`[ChannelRepo.listByWorkspace] ${error.message}`);
    }

    return data ?? [];
  }

  /**
   * Upsert a channel. Matches on (workspace_id, slack_channel_id).
   */
  async upsert(payload: ChannelInsert): Promise<ChannelRow> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .upsert(
        { ...payload, updated_at: new Date().toISOString() },
        { onConflict: 'workspace_id,slack_channel_id' }
      )
      .select()
      .single();

    if (error) {
      throw new Error(`[ChannelRepo.upsert] ${error.message}`);
    }

    return data;
  }

  /**
   * Bulk upsert — used during channel sync to write many channels at once.
   * Returns the count of rows written.
   */
  async bulkUpsert(payloads: ChannelInsert[]): Promise<number> {
    if (payloads.length === 0) return 0;

    const now = new Date().toISOString();
    const rows = payloads.map((p) => ({ ...p, updated_at: now }));

    const { data, error } = await supabase
      .from(this.TABLE)
      .upsert(rows, { onConflict: 'workspace_id,slack_channel_id' })
      .select('id');

    if (error) {
      throw new Error(`[ChannelRepo.bulkUpsert] ${error.message}`);
    }

    logger.debug(
      { workspaceId: payloads[0]?.workspace_id, count: data?.length ?? 0 },
      '[ChannelRepo] Bulk upserted channels'
    );

    return data?.length ?? 0;
  }

  /**
   * Update last sync timestamp for a channel.
   */
  async updateLastSynced(workspaceId: string, slackChannelId: string): Promise<void> {
    const { error } = await supabase
      .from(this.TABLE)
      .update({
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_id', workspaceId)
      .eq('slack_channel_id', slackChannelId);

    if (error) {
      throw new Error(`[ChannelRepo.updateLastSynced] ${error.message}`);
    }
  }

  /**
   * Update channel fields (e.g. after receiving a channel_renamed event).
   */
  async update(workspaceId: string, id: string, payload: ChannelUpdate): Promise<ChannelRow> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .select()
      .single();

    if (error) {
      throw new Error(`[ChannelRepo.update] ${error.message}`);
    }

    return data;
  }
}
