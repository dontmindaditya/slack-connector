import { logger } from './logger';

export interface RetryOptions {
  retries?: number;          // Max attempts (default: 3)
  initialDelayMs?: number;   // First retry delay (default: 500ms)
  maxDelayMs?: number;       // Cap on delay (default: 10_000ms)
  factor?: number;           // Backoff multiplier (default: 2)
  label?: string;            // For logging
  shouldRetry?: (err: unknown) => boolean;  // Custom retry gate
}

/**
 * Wraps an async function with retry logic using exponential backoff.
 *
 * Usage:
 *   const result = await withRetry(
 *     () => slackClient.conversations.list(...),
 *     { retries: 3, label: 'conversations.list' }
 *   );
 *
 * Respects Slack's Retry-After header for 429 responses.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    initialDelayMs = 500,
    maxDelayMs = 10_000,
    factor = 2,
    label = 'operation',
    shouldRetry = defaultShouldRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isLast = attempt === retries;

      if (isLast || !shouldRetry(err)) {
        throw err;
      }

      // Check for Slack 429 Retry-After
      const retryAfterMs = extractRetryAfter(err);

      const backoffMs = retryAfterMs ?? Math.min(
        initialDelayMs * Math.pow(factor, attempt),
        maxDelayMs
      );

      // Add jitter ±10% to prevent thundering herd
      const jitter = backoffMs * 0.1 * (Math.random() * 2 - 1);
      const delayMs = Math.round(backoffMs + jitter);

      logger.warn(
        {
          label,
          attempt: attempt + 1,
          maxAttempts: retries + 1,
          delayMs,
          err: (err as Error).message,
        },
        `[Retry] Attempt ${attempt + 1} failed — retrying in ${delayMs}ms`
      );

      await sleep(delayMs);
    }
  }

  throw lastError;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultShouldRetry(err: unknown): boolean {
  if (!(err instanceof Error)) return true;

  const msg = err.message.toLowerCase();

  // Don't retry on permanent errors
  const permanent = [
    'not_in_channel',
    'channel_not_found',
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'missing_scope',
    'invalid_cursor',
  ];

  for (const code of permanent) {
    if (msg.includes(code)) return false;
  }

  // Retry on rate limits, timeouts, network errors
  return true;
}

function extractRetryAfter(err: unknown): number | null {
  if (!(err instanceof Error)) return null;

  // Slack SDK attaches retryAfter in milliseconds on rate limit errors
  const candidate = err as Error & { retryAfter?: number };
  if (typeof candidate.retryAfter === 'number') {
    return candidate.retryAfter * 1000; // Convert seconds → ms
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}