import type { UserRole } from '../db/schema/users'

/**
 * Leapify application user.
 * Built from the Better Auth session + our `users` D1 row.
 * Cached in KV under `auth:session:<token>` for the session's lifetime.
 */
export interface LeapifyUser {
  /** Better Auth user.id (stored as users.better_auth_id) */
  uid: string
  /** Our internal users.id (used for FK joins in bookmarks, etc.) */
  dbId: string
  role: UserRole
  email: string
  name: string
  emailVerified: boolean
  /** Unix epoch ms when the Better Auth session expires. Used to detect stale cache entries. */
  sessionExpiresAt: number
}
