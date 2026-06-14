import { randomUUID } from 'node:crypto'
import type { LeapifyUser } from '../../src/auth/types'

const SESSION_KV_PREFIX = 'auth:session:'

/**
 * Insert a real Better Auth `session` row into the in-memory SQLite DB
 * and cache the corresponding `LeapifyUser` in the mock KV so the
 * `authMiddleware` fast-path hits without ever calling Better Auth's
 * `getSession()`.
 *
 * How the middleware works:
 *  1. extractRawToken() reads `Authorization: Bearer <token>`
 *  2. KV.get(`auth:session:<token>`, 'json') → if hit, short-circuit ✓
 *  3. Only on miss: calls auth.api.getSession() → queries the `session` table
 *
 * By seeding BOTH the KV cache (step 2) AND the session table (step 3 fallback)
 * we cover both code paths in tests.
 *
 * @returns The opaque session token string to use as `Authorization: Bearer <token>`
 */
import { authUser, authSession } from '../../src/db/schema/auth'

export async function makeTestSession(
  db: any,
  kv: any,
  uid: string,
  role: LeapifyUser['role'],
  dbId: string,
): Promise<string> {
  const token = randomUUID()
  const now = new Date()
  const expiresAt = new Date(Date.now() + 3600 * 1000) // 1 hour from now

  // Insert a Better Auth `session` row so auth.api.getSession() can find it
  // if the KV cache were to miss (e.g. after a KV reset in tests).
  // The `user_id` must exist in the `user` table — insert a minimal row first.
  await db.insert(authUser).values({
    id: uid,
    name: role === 'admin' ? 'Test Admin' : 'Test Student',
    email: `${uid}@dlsu.edu.ph`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing()

  await db.insert(authSession).values({
    id: randomUUID(),
    expiresAt,
    token,
    userId: uid,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing()

  // Pre-seed KV so the middleware fast-path hits on every test request
  const leapifyUser: LeapifyUser = {
    uid,
    dbId,
    role,
    email: `${uid}@dlsu.edu.ph`,
    name: role === 'admin' ? 'Test Admin' : 'Test Student',
    emailVerified: true,
    sessionExpiresAt: expiresAt.getTime(),
  }
  await kv.put(`${SESSION_KV_PREFIX}${token}`, JSON.stringify(leapifyUser))

  return token
}
