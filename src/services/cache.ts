import type { KVNamespace } from '@cloudflare/workers-types'

// Module-level write dedup — prevents thundering herd of concurrent KV PUTs for same key
const _pendingWrites = new Set<string>()

/**
 * Typed KV cache wrapper with get/set/del and stale-while-revalidate helpers.
 */
export class CacheService {
  constructor(private readonly kv: KVNamespace) {}

  async get<T>(key: string): Promise<T | null> {
    return this.kv.get<T>(key, 'json')
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (_pendingWrites.has(key)) return  // already writing this key — skip duplicate
    _pendingWrites.add(key)
    try {
      await this.kv.put(key, JSON.stringify(value), {
        ...(ttlSeconds ? { expirationTtl: ttlSeconds } : {}),
      })
    } catch (err: unknown) {
      // KV write rate limit (429) or transient error — non-fatal, next request will retry
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('429')) console.warn('[Cache] KV set failed:', msg)
    } finally {
      _pendingWrites.delete(key)
    }
  }

  async del(key: string): Promise<void> {
    await this.kv.delete(key)
  }

  /**
   * Returns cached value immediately. If stale or missing, refreshes in
   * the background using the provided fetcher. Pass `ctx` to use
   * ctx.waitUntil() so the refresh doesn't block the response.
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number,
    ctx?: ExecutionContext,
  ): Promise<T> {
    const cached = await this.get<T>(key)
    if (cached !== null) return cached

    const fresh = await fetcher()
    const writePromise = this.set(key, fresh, ttlSeconds)

    if (ctx) {
      ctx.waitUntil(writePromise)
    } else {
      await writePromise
    }

    return fresh
  }

  /**
   * Generate a simple ETag from a version string by hashing with SHA-256.
   */
  async generateETag(versionString: string): Promise<string> {
    const encoder = new TextEncoder()
    const data = encoder.encode(versionString)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return `"${hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')}"`
  }
}
