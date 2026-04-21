import { WebClient, LogLevel } from '@slack/web-api';
import { env, IS_PRODUCTION } from './env';


const clientCache = new Map<string, WebClient>();

/**
 * Returns a memoized WebClient for the given bot token.
 * Safe to call repeatedly — won't create duplicate instances.
 */
export function getSlackClient(botToken: string): WebClient {
  if (clientCache.has(botToken)) {
    return clientCache.get(botToken)!;
  }

  const client = new WebClient(botToken, {
    logLevel: IS_PRODUCTION ? LogLevel.ERROR : LogLevel.WARN,
    retryConfig: {
      // Slack SDK has built-in retry — we handle additional retries in utils/retry.ts
      retries: 2,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 10000,
    },
    rejectRateLimitedCalls: false, // Let our rate limiter handle 429s
  });

  clientCache.set(botToken, client);
  return client;
}

/**
 * Removes a workspace's cached client — call this on token revocation
 * or workspace uninstall to prevent stale token usage.
 */
export function evictSlackClient(botToken: string): void {
  clientCache.delete(botToken);
}

/**
 * OAuth-only client (no token) — used during the install flow
 * to exchange the authorization code for a token.
 */
export const oauthClient = new WebClient(undefined, {
  logLevel: IS_PRODUCTION ? LogLevel.ERROR : LogLevel.WARN,
});

/**
 * Slack OAuth config — used in auth.service.ts
 */
export const slackOAuthConfig = {
  clientId: env.SLACK_CLIENT_ID,
  clientSecret: env.SLACK_CLIENT_SECRET,
  redirectUri: env.SLACK_REDIRECT_URI,
  scopes: env.SLACK_BOT_SCOPES.split(',').map((s) => s.trim()),
};
