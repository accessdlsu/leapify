/**
 * Better Auth database tables for SQLite / D1.
 *
 * These are the four tables Better Auth requires to manage sessions, accounts,
 * and email-verification tokens.  They are defined here as Drizzle schema so
 * we own the migration (generated via `npm run db:generate`).
 *
 * Column names and types match what `npx @better-auth/cli generate` produces
 * for the sqlite dialect — do NOT rename them; Better Auth queries by these
 * exact column names.
 *
 * Relationship to our `users` table:
 *   Better Auth `user.id`  →  leapify `users.better_auth_id`
 *   (the FK lives on our side so we can join without touching BA internals)
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// ─── user ───────────────────────────────────────────────────────────────────
// Better Auth's own user record.  Stores identity, email verification status,
// and the profile image URL coming from the Google account.

export const authUser = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .notNull()
    .default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
})

// ─── session ─────────────────────────────────────────────────────────────────
// One row per active session.  `token` is the opaque bearer token / cookie
// value clients present on each request.

export const authSession = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
)

// ─── account ─────────────────────────────────────────────────────────────────
// OAuth provider account linked to a user.  One row per provider per user
// (e.g. a user who signed in with Google has one `account` with providerId="google").

export const authAccount = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
)

// ─── verification ─────────────────────────────────────────────────────────────
// Short-lived tokens used for email verification / magic links.

export const authVerification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
)
