import { oauthClient, getSlackClient, evictSlackClient, slackOAuthConfig } from '../../config/slack';
import { WorkspaceRepo } from '../supabase/workspace.repo';
import type { SlackOAuthResult } from '../../types/slack.types';
import { logger } from '../../utils/logger';
import { withRetry } from '../../utils/retry';
import { encryptToken, decryptToken } from '../../utils/encryption';
import { env } from '../../config/env';

export class AuthService {
  private readonly workspaceRepo: WorkspaceRepo;

  constructor() {
    this.workspaceRepo = new WorkspaceRepo();
  }

  
  async exchangeCode(code: string): Promise<SlackOAuthResult> {
    const response = await withRetry(
      () =>
        oauthClient.oauth.v2.access({
          client_id: slackOAuthConfig.clientId,
          client_secret: slackOAuthConfig.clientSecret,
          code,
          redirect_uri: slackOAuthConfig.redirectUri,
        }),
      { retries: 2, label: 'slack.oauth.v2.access' }
    );

    if (!response.ok) {
      throw new Error(`Slack OAuth exchange failed: ${response.error}`);
    }

    const team = response.team as { id: string; name: string };
    const botToken = (response.access_token as string) ?? '';
    const botUserId = (response.bot_user_id as string) ?? '';
    const authedUser = response.authed_user as { id: string };
    const appId = (response.app_id as string) ?? '';
    const scope = (response.scope as string) ?? '';

    if (!botToken || !team?.id) {
      throw new Error('OAuth response missing required fields (token or team)');
    }

    // Fetch team info for domain + icon
    const client = getSlackClient(botToken);
    let domain = '';
    let iconUrl: string | undefined;

    try {
      const teamInfo = await client.team.info({ team: team.id });
      if (teamInfo.ok && teamInfo.team) {
        domain = (teamInfo.team as Record<string, unknown>)['domain'] as string ?? '';
        iconUrl = ((teamInfo.team as Record<string, unknown>)['icon'] as Record<string, string>)?.['image_88'];
      }
    } catch (err) {
      logger.warn({ err, teamId: team.id }, '[AuthService] Could not fetch team info — non-fatal');
    }

    const result: SlackOAuthResult = {
      workspaceId: team.id,
      workspaceName: team.name,
      botToken,
      botUserId,
      installedByUserId: authedUser?.id ?? '',
      scope,
      appId,
    };

    // Upsert workspace into Supabase
    await this.workspaceRepo.upsert({
      slack_team_id: team.id,
      name: team.name,
      domain,
      icon_url: iconUrl ?? null,
      bot_user_id: botUserId,
      bot_token: encryptToken(botToken, env.TOKEN_ENCRYPTION_KEY),
      installed_by_user_id: result.installedByUserId,
      app_id: appId,
      scope,
      is_active: true,
    });

    logger.info({ teamId: team.id, workspaceName: team.name }, '[AuthService] Workspace installed');

    return result;
  }

  /**
   * Calls auth.test to verify a bot token is still valid.
   */
  async verifyToken(botToken: string): Promise<boolean> {
    try {
      const client = getSlackClient(botToken);
      const response = await client.auth.test();
      return response.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Marks a workspace as inactive and evicts the cached client.
   * Called on app_uninstalled event or manual revocation.
   */
  async revokeWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) return;

    // Mark inactive in DB
    await this.workspaceRepo.deactivate(workspaceId);

    // Evict cached client — decrypt first since the stored token may be encrypted
    evictSlackClient(decryptToken(workspace.bot_token, env.TOKEN_ENCRYPTION_KEY));

    logger.info({ workspaceId }, '[AuthService] Workspace revoked');
  }
}
