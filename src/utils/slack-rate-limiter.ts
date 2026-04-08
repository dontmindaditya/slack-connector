import { logger } from './logger';

/**
 * Per-workspace Slack API rate limiter.
 *
 * Slack enforces rate limits per (method, workspace, app).
 * Tier 3 methods (conversations.history, conversations.list) allow 50 req/min.
 * Tier 4 methods allow 100 req/min.
 *
 * This limiter uses a token bucket algorithm per workspace to ensure
 * we stay within Slack's limits when running concurrent syncs.
 *
 * Usage:
 *   await slackRateLimiter.acquire('workspace-id', 'tier3');
 *   // now safe to make the API call
 */

type Tier = 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'message';

// Requests per minute per tier (conservative — below Slack's stated limits)
const TIER_RPM: Record<Tier, number> = {
  tier1: 1,
  tier2: 15,
  tier3: 40,
  tier4: 80,
  message: 50, // chat.postMessage: 1/s per channel, ~50/min workspace-wide
};

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

class SlackRateLimiter {
  // Key: `${workspaceId}:${tier}`
  private readonly buckets = new Map<string, TokenBucket>();

  /**
   * Acquires a token for the given workspace and tier.
   * Waits (with backoff) if no tokens are available.
   */
  async acquire(workspaceId: string, tier: Tier = 'tier3'): Promise<void> {
    const key = `${workspaceId}:${tier}`;
    const rpm = TIER_RPM[tier];
    const refillIntervalMs = (60 * 1000) / rpm; // ms between tokens

    const maxWaitMs = 30_000; // Never wait more than 30s
    const startMs = Date.now();

    while (true) {
      const bucket = this._getBucket(key, rpm);
      this._refill(bucket, rpm, refillIntervalMs);

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }

      // No tokens — wait for next refill
      const waitMs = refillIntervalMs;

      if (Date.now() - startMs + waitMs > maxWaitMs) {
        logger.warn(
          { workspaceId, tier, waitedMs: Date.now() - startMs },
          '[SlackRateLimiter] Exceeded max wait — proceeding anyway'
        );
        return;
      }

      await sleep(waitMs);
    }
  }

  /**
   * Signals that Slack returned a 429 for this workspace/tier.
   * Drains the bucket so subsequent callers will wait.
   */
  reportRateLimit(workspaceId: string, tier: Tier, retryAfterSeconds: number): void {
    const key = `${workspaceId}:${tier}`;
    const bucket = this._getBucket(key, TIER_RPM[tier]);

    // Drain all tokens and set lastRefill far in the future
    bucket.tokens = 0;
    bucket.lastRefill = Date.now() + retryAfterSeconds * 1000;

    logger.warn(
      { workspaceId, tier, retryAfterSeconds },
      '[SlackRateLimiter] Rate limit reported — bucket drained'
    );
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private _getBucket(key: string, rpm: number): TokenBucket {
    if (!this.buckets.has(key)) {
      this.buckets.set(key, { tokens: rpm, lastRefill: Date.now() });
    }
    return this.buckets.get(key)!;
  }

  private _refill(bucket: TokenBucket, rpm: number, refillIntervalMs: number): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const newTokens = Math.floor(elapsed / refillIntervalMs);

    if (newTokens > 0) {
      bucket.tokens = Math.min(bucket.tokens + newTokens, rpm);
      bucket.lastRefill = now;
    }
  }
}

export const slackRateLimiter = new SlackRateLimiter();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}