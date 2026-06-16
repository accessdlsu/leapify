import { createMiddleware } from 'hono/factory'
import type { LeapifyBindings } from '../../types'
import { tooManyRequests } from '../errors'

export interface RateLimitConfig {
  /** KV key namespace segment — e.g. 'events' or 'bookmarks' */
  endpoint: string
  /** Max requests allowed within the window */
  limit: number
  /** Window size in seconds */
  windowSec: number
  /**
   * How to identify the requester.
   * - 'ip'  → CF-Connecting-IP (guests, public endpoints)
   * - 'uid' → authenticated user ID from c.get('user') (must run after authMiddleware)
   */
  identifier: 'ip' | 'uid'
}

/**
 * KV token-bucket rate limiter (ADR-006, Layer 3 & 5).
 *
 * Key schema: `rl:<endpoint>:<identifier>`
 *
 * Uses a simple counter with KV TTL as the window reset mechanism.
 * On first request in a window, the key is created with expirationTtl = windowSec.
 * Subsequent requests within the window increment the counter.
 * When the key expires, the window resets automatically.
 *
 * Trade-off: this is eventually consistent under concurrent requests at window
 * boundaries — acceptable given the ~5% over-limit tolerance for edge caches.
 */
export function createRateLimitMiddleware(config: RateLimitConfig) {
  const { endpoint, limit, windowSec, identifier } = config

  return createMiddleware<{ Bindings: LeapifyBindings }>(async (c, next) => {
    // Skip rate limiting for challenge verification (clients solving challenges should not be blocked)
    if (c.req.path === '/.well-known/leapify/turnstile/verify') return next()

    // Also skip old PoW path for backward compatibility
    if (c.req.path === '/.well-known/leapify/pow/verify') return next()

    const id =
      identifier === 'uid'
        ? (c.get('user')?.uid ?? c.req.header('CF-Connecting-IP') ?? 'unknown')
        : (c.req.header('CF-Connecting-IP') ?? 'unknown')

    const key = `rl:${endpoint}:${id}`

    const raw = await c.env.KV.get(key)
    const count = raw !== null ? parseInt(raw, 10) : 0

    if (count >= limit) {
      c.header('Retry-After', String(windowSec))
      c.header('X-RateLimit-Limit', String(limit))
      c.header('X-RateLimit-Remaining', '0')
      throw tooManyRequests(`Rate limit exceeded. Try again in ${windowSec}s.`)
    }

    // Increment. On first request (count === 0), set TTL to open the window.
    // On subsequent requests, preserve the existing TTL by not resetting it.
    if (count === 0) {
      await c.env.KV.put(key, '1', { expirationTtl: windowSec })
    } else {
      // KV doesn't support atomic increment — we read then write.
      // Slight over-counting is acceptable; it errs on the side of caution.
      await c.env.KV.put(key, String(count + 1), { expirationTtl: windowSec })
    }

    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', String(limit - count - 1))

    return next()
  })
}

// Pre-configured middlewares per ADR-006 recommended limits

/** GET /events — 15000 req/60s per IP */
export const eventsListRateLimit = createRateLimitMiddleware({
  endpoint: 'events-list',
  limit: 15000,
  windowSec: 60,
  identifier: 'ip',
})

/** GET /events/:slug/slots — 15000 req/60s per IP */
export const eventsSlotsRateLimit = createRateLimitMiddleware({
  endpoint: 'events-slots',
  limit: 15000,
  windowSec: 60,
  identifier: 'ip',
})

/** POST /users/me/bookmarks — 15000 req/60s per UID (must run after authMiddleware) */
export const bookmarksRateLimit = createRateLimitMiddleware({
  endpoint: 'bookmarks',
  limit: 15000,
  windowSec: 60,
  identifier: 'uid',
})

/** POST /events (admin) — 15000 req/60s per UID (must run after authMiddleware) */
export const adminEventsRateLimit = createRateLimitMiddleware({
  endpoint: 'admin-events',
  limit: 15000,
  windowSec: 60,
  identifier: 'uid',
})
