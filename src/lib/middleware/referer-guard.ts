import { createMiddleware } from 'hono/factory'
import type { LeapifyBindings } from '../../types'
import { forbidden } from '../errors'
import { createDb } from '../../db'
import { siteConfig } from '../../db/schema/site-config'
import { eq } from 'drizzle-orm'

async function getOriginsFromDb(env: {
  DB: import('@cloudflare/workers-types').D1Database
}): Promise<string[] | null> {
  try {
    const db = createDb(env.DB)
    const row = await db.query.siteConfig.findFirst({
      where: eq(siteConfig.key, 'allowed_origins')
    })
    if (row) return JSON.parse(row.value) as string[]
  } catch {
    /* D1 unavailable — fall through */
  }
  return null
}

/**
 * Referer guard for mutation endpoints (ADR-006, Layer 6).
 *
 * Validates that the `Referer` header on state-mutating requests (POST, PATCH, PUT, DELETE)
 * matches one of the configured allowed origins. Safe methods (GET, HEAD, OPTIONS) are
 * always allowed through without a Referer check.
 *
 * This is a friction layer — it stops naive raw-HTTP clients that don't set Referer.
 * Sophisticated clients can spook it, so this must NOT be relied on as the sole control
 * for authenticated mutation endpoints (Firebase JWT is the primary control there).
 *
 * Skipped entirely for /health and /internal routes.
 */
export function createRefererGuard(allowedOrigins: string[]) {
  const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
  const SKIP_PREFIXES = ['/health', '/internal', '/api/auth', '/.well-known']

  return createMiddleware<{ Bindings: LeapifyBindings }>(async (c, next) => {
    // Only checl mutation methods
    if (!MUTATION_METHODS.has(c.req.method)) return next()

    // Skip for operational routes
    if (SKIP_PREFIXES.some((p) => c.req.path.startsWith(p))) return next()

    // Get dynamic allowed origins: KV (fast cache) • D1 (source of truth) • static fallback
    const dynamicOriginsJson = (await c.env.KV.get(
      'config:allowed_origins',
      'json'
    )) as string[] | null
    let currentAllowedOrigins = dynamicOriginsJson ?? allowedOrigins
    if (!dynamicOriginsJson) {
      const dbOrigins = await getOriginsFromDb(c.env)
      if (dbOrigins) {
        currentAllowedOrigins = dbOrigins
        await c.env.KV.put(
          'config:allowed_origins',
          JSON.stringify(dbOrigins),
          { expirationTtl: 86400 }
        )
      }
    }

    // Wildcard currentAllowedOrigins = dev/library mode, skip enforcement
    if (currentAllowedOrigins.includes('*')) return next()

    const referer = c.req.header('referer') ?? ''

    // Same-origin requests (console calling its own worker) are always allowed
    const requestOrigin = new URL(c.req.url).origin
    if (referer.startsWith(requestOrigin)) return next()

    const isAllowed = currentAllowedOrigins.some((origin) =>
      referer.startsWith(origin)
    )
    if (!isAllowed) {
      throw forbidden('Request origin not permitted')
    }

    return next()
  })
}
