/**
 * Lightweight LRU (Least Recently Used) in-memory cache.
 *
 * Used for:
 *   - Caching Slack user objects (avoid hammering users.info per message)
 *   - Caching workspace token lookups within a single request burst
 *
 * This is process-local — not shared between worker instances.
 * For distributed caching, replace with Redis (ioredis).
 *
 * Usage:
 *   lruCache.set('user:W123:U456', userObj, 5 * 60 * 1000);
 *   const user = lruCache.get<SlackUser>('user:W123:U456');
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class LRUCache {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Gets a cached value. Returns undefined on miss or expiry.
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) return undefined;

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used) — O(1) in Map
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value as T;
  }

  /**
   * Sets a value with a TTL in milliseconds.
   * @param ttlMs Default: 5 minutes
   */
  set<T>(key: string, value: T, ttlMs = 5 * 60 * 1000): void {
    // Evict expired entries on write to keep memory clean
    if (this.cache.size >= this.maxSize) {
      this._evictExpired();
    }

    // If still over capacity, evict the LRU (first) entry
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Removes a specific key.
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Removes all keys matching a prefix.
   * Useful for cache invalidation: `invalidatePrefix('user:workspace-id:')`.
   */
  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clears the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Returns current number of entries (including possibly-expired ones).
   */
  get size(): number {
    return this.cache.size;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private _evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * Singleton LRU cache — import and use directly.
 * Max 1000 entries.
 */
export const lruCache = new LRUCache(1000);