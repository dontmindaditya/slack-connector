import { supabase } from '../../config/supabase';
import type { WorkspaceRow, WorkspaceInsert, WorkspaceUpdate } from '../../types/supabase.types';
import { logger } from '../../utils/logger';

export class WorkspaceRepo {
  private readonly TABLE = 'slack_workspaces' as const;

  /**
   * Find workspace by internal UUID.
   */
  async findById(id: string): Promise<WorkspaceRow | null> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // not found
      throw new Error(`[WorkspaceRepo.findById] ${error.message}`);
    }

    return data;
  }

  /**
   * Find workspace by Slack team_id (e.g. "T01234ABC").
   * This is used during event processing where we only have the Slack team_id.
   */
  async findBySlackTeamId(slackTeamId: string): Promise<WorkspaceRow | null> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .select('*')
      .eq('slack_team_id', slackTeamId)
      .eq('is_active', true)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`[WorkspaceRepo.findBySlackTeamId] ${error.message}`);
    }

    return data;
  }

  /**
   * Upsert a workspace — handles both fresh installs and reinstalls.
   * Matches on slack_team_id.
   */
  async upsert(payload: WorkspaceInsert): Promise<WorkspaceRow> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .upsert(
        { ...payload, updated_at: new Date().toISOString() },
        { onConflict: 'slack_team_id' }
      )
      .select()
      .single();

    if (error) {
      throw new Error(`[WorkspaceRepo.upsert] ${error.message}`);
    }

    logger.debug({ slackTeamId: payload.slack_team_id }, '[WorkspaceRepo] Workspace upserted');
    return data;
  }

  /**
   * Update arbitrary workspace fields.
   */
  async update(id: string, payload: WorkspaceUpdate): Promise<WorkspaceRow> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`[WorkspaceRepo.update] ${error.message}`);
    }

    return data;
  }

  /**
   * Marks a workspace as inactive (soft delete).
   * Called on app_uninstalled events.
   */
  async deactivate(id: string): Promise<void> {
    const { error } = await supabase
      .from(this.TABLE)
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      throw new Error(`[WorkspaceRepo.deactivate] ${error.message}`);
    }

    logger.info({ workspaceId: id }, '[WorkspaceRepo] Workspace deactivated');
  }

  /**
   * Lists all active workspaces — used by background jobs.
   */
  async listActive(): Promise<WorkspaceRow[]> {
    const { data, error } = await supabase
      .from(this.TABLE)
      .select('*')
      .eq('is_active', true)
      .order('installed_at', { ascending: false });

    if (error) {
      throw new Error(`[WorkspaceRepo.listActive] ${error.message}`);
    }

    return data ?? [];
  }
}