import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { createAuth } from './auth'
import { domainRestricted, unauthorized, forbidden } from '../lib/errors'
import { createDb } from '../db'
import { users } from '../db/schema/users'
import type { LeapifyBindings } from '../types'
import type { LeapifyUser } from './types'

const SESSION_KV_PREFIX = 'auth:session:'
const SESSION_KV_TTL = 3600 // 1 hour max cache (capped by actual session expiry)

// Context type augmentation — available in every route handler via c.get('user')
declare module 'hono' {
  interface ContextVariableMap {
    user: LeapifyUser
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the raw bearer token from the Authorization header, or the
 * `better-auth.session_token` cookie, for use as a KV cache key.
 * Returns undefined when no credential is present.
 */
function extractRawToken(c: { req: { header: (k: string) => string | undefined } }): string | undefined {
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  // Cookie-based flow: Better Auth sets this cookie name by default
  const cookie = c.req.header('Cookie') ?? ''
  const match = cookie.match(/(?:^|;\s*)better-auth\.session_token=([^;]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

async function resolveUser(
  env: LeapifyBindings,
  betterAuthUserId: string,
  betterAuthUserEmail: string,
  betterAuthUserName: string,
  betterAuthEmailVerified: boolean,
): Promise<LeapifyUser> {
  const db = createDb(env.DB)

  let dbUser = await db.query.users.findFirst({
    where: eq(users.betterAuthId, betterAuthUserId),
  })

  if (!dbUser) {
    // First request after account creation — the databaseHooks.after callback
    // should have already inserted this row, but guard against races.
    const [created] = await db
      .insert(users)
      .values({
        betterAuthId: betterAuthUserId,
        email: betterAuthUserEmail,
        name: betterAuthUserName ?? betterAuthUserEmail.split('@')[0],
      })
      .onConflictDoNothing({ target: users.betterAuthId })
      .returning()
    dbUser = created
  }

  if (!dbUser) throw unauthorized('Failed to resolve user record')

  return {
    uid: betterAuthUserId,
    dbId: dbUser.id,
    role: dbUser.role,
    email: betterAuthUserEmail,
    name: betterAuthUserName ?? betterAuthUserEmail.split('@')[0],
    emailVerified: betterAuthEmailVerified,
  }
}

// ─── Auth middleware (required) ───────────────────────────────────────────────

export const authMiddleware = createMiddleware<{ Bindings: LeapifyBindings }>(
  async (c, next) => {
    const rawToken = extractRawToken(c)

    // Fast path: KV cache hit — skip DB round-trip entirely
    if (rawToken) {
      const cached = await c.env.KV.get<LeapifyUser>(
        `${SESSION_KV_PREFIX}${rawToken}`,
        'json',
      )
      if (cached) {
        c.set('user', cached)
        return next()
      }
    }

    // Slow path: validate session via Better Auth
    const auth = createAuth(c.env)
    const session = await auth.api.getSession({ headers: c.req.raw.headers })

    if (!session?.user) {
      throw unauthorized('No valid session found')
    }

    // Domain guard — belt-and-suspenders (databaseHooks already rejects at
    // account creation time, but protects in case an existing account somehow
    // has a non-DLSU email)
    if (!session.user.email.endsWith('@dlsu.edu.ph')) {
      throw domainRestricted()
    }

    const leapifyUser = await resolveUser(
      c.env,
      session.user.id,
      session.user.email,
      session.user.name,
      session.user.emailVerified,
    )

    // Cache in KV, TTL = min(time until session expires, 1 hour)
    if (rawToken) {
      const sessionExpiresAt = new Date(session.session.expiresAt).getTime()
      const secondsRemaining = Math.floor((sessionExpiresAt - Date.now()) / 1000)
      const kvTtl = Math.max(1, Math.min(secondsRemaining, SESSION_KV_TTL))
      await c.env.KV.put(
        `${SESSION_KV_PREFIX}${rawToken}`,
        JSON.stringify(leapifyUser),
        { expirationTtl: kvTtl },
      )
    }

    c.set('user', leapifyUser)
    return next()
  },
)

// ─── Optional auth middleware ─────────────────────────────────────────────────

export const optionalAuthMiddleware = createMiddleware<{
  Bindings: LeapifyBindings
}>(async (c, next) => {
  const rawToken = extractRawToken(c)
  // No credential present → treat as guest
  if (!rawToken) {
    c.set('user', null as unknown as LeapifyUser)
    return next()
  }
  // Credential present → enforce full verification
  return authMiddleware(c, next)
})

// ─── Admin guard (use after authMiddleware) ───────────────────────────────────

export const adminMiddleware = createMiddleware<{ Bindings: LeapifyBindings }>(
  async (c, next) => {
    const user = c.get('user')
    if (!user || !['admin', 'super_admin'].includes(user.role)) {
      throw forbidden('Admin access required')
    }
    return next()
  },
)

// ─── Internal route guard ─────────────────────────────────────────────────────

export const internalMiddleware = createMiddleware<{
  Bindings: LeapifyBindings
}>(async (c, next) => {
  const secret = c.req.header('X-Internal-Secret')
  if (!secret || secret !== c.env.INTERNAL_API_SECRET) {
    throw forbidden('Invalid internal secret')
  }
  return next()
})
