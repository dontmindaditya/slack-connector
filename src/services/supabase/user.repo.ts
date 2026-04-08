import { supabase } from '../../config/supabase';
import type { UserRow, UserInsert, UserUpdate } from '../../types/supabase.types';
import { logger } from '../../utils/logger';

export class UserRepo {
  private readonly TABLE = 'slack_users' as const;

  /**
   * Fetch multiple users by their Slack IDs in a single DB round-trip.
   * Used by _discoverUsers to avoid N+1 existence checks.
   */
  async findManyBySlackUserIds(workspaceId: string, slackUserIds: string[]): Promise<UserRow[]> {
    if (slackUserIds.length === 0) return [];

    const { data, error } = await supabase
      .from(this.TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .in('slack_user_id', slackUserIds);

    if (error) {
      throw new Error(`[UserRepo.findManyBySlackUserIds] ${error.message}`);
    }

    return data ?? [];
  }

  /**
   * Find user by Slack user ID within a workspace.
   */
  async findBySlackUserId(workspaceId: string, slackUserId: string): Promise<UserRow | null> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('slack_user_id', slackUserId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`[UserRepo.findBySlackUserId] ${error.message}`);
    }

    return data;
  }

  /**
   * List all users for a workspace.
   */
  async listByWorkspace(
    workspaceId: string,
    options: { includeDeleted?: boolean; limit?: number; offset?: number } = {}
  ): Promise<UserRow[]> {
    let query = supabase
      .from(this.TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('real_name', { ascending: true });

    if (!options.includeDeleted) {
      query = query.eq('is_deleted', false);
    }

    if (options.limit) {
      const from = options.offset ?? 0;
      query = query.range(from, from + options.limit - 1);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`[UserRepo.listByWorkspace] ${error.message}`);
    }

    return data ?? [];
  }

  /**
   * Upsert a single user. Matches on (workspace_id, slack_user_id).
   */
  async upsert(payload: UserInsert): Promise<UserRow> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .upsert(
        { ...payload, updated_at: new Date().toISOString() },
        { onConflict: 'workspace_id,slack_user_id' }
      )
      .select()
      .single();

    if (error) {
      throw new Error(`[UserRepo.upsert] ${error.message}`);
    }

    return data;
  }

  /**
   * Bulk upsert users — used during workspace user sync.
   */
  async bulkUpsert(payloads: UserInsert[]): Promise<number> {
    if (payloads.length === 0) return 0;

    const BATCH_SIZE = 500;
    let totalInserted = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads
        .slice(i, i + BATCH_SIZE)
        .map((p) => ({ ...p, updated_at: now }));

      const { data, error } = await supabase
        .from(this.TABLE)
        .upsert(batch, { onConflict: 'workspace_id,slack_user_id' })
        .select('id');

      if (error) {
        throw new Error(`[UserRepo.bulkUpsert] batch ${i}: ${error.message}`);
      }

      totalInserted += data?.length ?? 0;
    }

    logger.debug(
      { workspaceId: payloads[0]?.workspace_id, count: totalInserted },
      '[UserRepo] Bulk upserted users'
    );

    return totalInserted;
  }

  /**
   * Update a user record.
   */
  async update(workspaceId: string, slackUserId: string, payload: UserUpdate): Promise<void> {
    const { error } = await supabase
      .from(this.TABLE)
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .eq('slack_user_id', slackUserId);

    if (error) {
      throw new Error(`[UserRepo.update] ${error.message}`);
    }
  }
}