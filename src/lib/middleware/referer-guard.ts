import { createMiddleware } from 'hono/factory'
import type { LeapifyBindings } from '../../types'
import { forbidden } from '../errors'

/**
 * Referer guard for mutation endpoints (ADR-006, Layer 6).
 *
 * Validates that the `Referer` header on state-mutating requests (POST, PATCH, PUT, DELETE)
 * matches one of the configured allowed origins. Safe methods (GET, HEAD, OPTIONS) are
 * always allowed through without a Referer check.
 *
 * This is a friction layer — it stops naive raw-HTTP clients that don't set Referer.
 * Sophisticated clients can spoof it, so this must NOT be relied on as the sole control
 * for authenticated mutation endpoints (Firebase JWT is the primary control there).
 *
 * Skipped entirely for /health and /internal routes.
 */
export function createRefererGuard(allowedOrigins: string[]) {
  const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
  const SKIP_PREFIXES = ['/health', '/internal', '/api/auth', '/.well-known']

  return createMiddleware<{ Bindings: LeapifyBindings }>(async (c, next) => {
    // Only check mutation methods
    if (!MUTATION_METHODS.has(c.req.method)) return next()

    // Skip for operational routes
    if (SKIP_PREFIXES.some((p) => c.req.path.startsWith(p))) return next()

    const dynamicOriginsJson = (await c.env.KV.get('config:allowed_origins', 'json')) as string[] | null
    const currentAllowedOrigins = dynamicOriginsJson ?? allowedOrigins

    // Wildcard currentAllowedOrigins = dev/library mode, skip enforcement
    if (currentAllowedOrigins.includes('*')) return next()

    const referer = c.req.header('referer') ?? ''

    const isAllowed = currentAllowedOrigins.some((origin) => referer.startsWith(origin))
    if (!isAllowed) {
      throw forbidden('Request origin not permitted')
    }

    return next()
  })
}
