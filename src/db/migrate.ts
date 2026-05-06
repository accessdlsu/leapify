/**
 * Auto-migration helper for D1 databases.
 *
 * When enabled, ensures all required tables exist on the first request.
 * Safe to call on every boot — all statements use IF NOT EXISTS.
 *
 * Import from 'leapify' — server-only.
 *
 * @example
 * // worker.ts
 * import { createLeapify } from 'leapify'
 *
 * export default createLeapify({ autoMigrate: true })
 */

// ─── Patches for existing databases ──────────────────────────────────────────
// ALTER TABLE statements that add columns added after initial deploy.
// Safe to run on every boot — duplicate column errors are caught and ignored.

const PATCH_STATEMENTS = [
  `ALTER TABLE "themes" ADD COLUMN "updated_at" integer NOT NULL DEFAULT (unixepoch())`,
  `ALTER TABLE "events" ADD COLUMN "organization_id" text`,
  `ALTER TABLE "events" ADD COLUMN "class_code" text`,
  `ALTER TABLE "events" ADD COLUMN "start_time" text`,
  `ALTER TABLE "events" ADD COLUMN "end_time" text`,
  `CREATE INDEX IF NOT EXISTS "idx_events_organization_id" ON "events" ("organization_id")`,
];

// ─── Full schema for fresh databases ────────────────────────────────────────

const CREATE_STATEMENTS = [
  // Better Auth: user
  `CREATE TABLE IF NOT EXISTS "user" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "email" text NOT NULL,
    "email_verified" integer DEFAULT false NOT NULL,
    "image" text,
    "created_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
    "updated_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "user_email_unique" ON "user" ("email")`,

  // Better Auth: session
  `CREATE TABLE IF NOT EXISTS "session" (
    "id" text PRIMARY KEY NOT NULL,
    "expires_at" integer NOT NULL,
    "token" text NOT NULL,
    "created_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
    "updated_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
    "ip_address" text,
    "user_agent" text,
    "user_id" text NOT NULL,
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "session_token_unique" ON "session" ("token")`,
  `CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("user_id")`,

  // Better Auth: account
  `CREATE TABLE IF NOT EXISTS "account" (
    "id" text PRIMARY KEY NOT NULL,
    "account_id" text NOT NULL,
    "provider_id" text NOT NULL,
    "user_id" text NOT NULL,
    "access_token" text,
    "refresh_token" text,
    "id_token" text,
    "access_token_expires_at" integer,
    "refresh_token_expires_at" integer,
    "scope" text,
    "password" text,
    "created_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
    "updated_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
  )`,
  `CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("user_id")`,

  // Better Auth: verification
  `CREATE TABLE IF NOT EXISTS "verification" (
    "id" text PRIMARY KEY NOT NULL,
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expires_at" integer NOT NULL,
    "created_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    "updated_at" integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`,
  `CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier")`,

  // App: users
  `CREATE TABLE IF NOT EXISTS "users" (
    "id" text PRIMARY KEY NOT NULL,
    "better_auth_id" text NOT NULL,
    "email" text NOT NULL,
    "name" text NOT NULL,
    "role" text DEFAULT 'student' NOT NULL,
    "created_at" integer DEFAULT (unixepoch()) NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_better_auth_id_unique" ON "users" ("better_auth_id")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" ("email")`,

  // App: organizations (before events, due to FK)
  `CREATE TABLE IF NOT EXISTS "organizations" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "acronym" text NOT NULL,
    "logo_url" text,
    "link" text,
    "created_at" integer DEFAULT (unixepoch()) NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "organizations_name_unique" ON "organizations" ("name")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "organizations_acronym_unique" ON "organizations" ("acronym")`,

  // App: themes (before events, due to FK)
  `CREATE TABLE IF NOT EXISTS "themes" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "path" text NOT NULL,
    "created_at" integer NOT NULL,
    "updated_at" integer NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "themes_name_unique" ON "themes" ("name")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "themes_path_unique" ON "themes" ("path")`,

  // App: events
  `CREATE TABLE IF NOT EXISTS "events" (
    "id" text PRIMARY KEY NOT NULL,
    "slug" text NOT NULL,
    "theme_id" text,
    "organization_id" text,
    "title" text NOT NULL,
    "description" text,
    "venue" text,
    "date_time" text,
    "price" text,
    "background_image_url" text,
    "class_code" text,
    "start_time" text,
    "end_time" text,
    "is_major" integer DEFAULT false NOT NULL,
    "max_slots" integer DEFAULT 0 NOT NULL,
    "registered_slots" integer DEFAULT 0 NOT NULL,
    "gforms_id" text,
    "gforms_url" text,
    "gforms_editor_url" text,
    "registration_closes_at" integer,
    "watch_id" text,
    "watch_expires_at" integer,
    "status" text DEFAULT 'draft' NOT NULL,
    "release_at" integer,
    "reminder_24h_sent" integer DEFAULT false NOT NULL,
    "reminder_1h_sent" integer DEFAULT false NOT NULL,
    "contentful_entry_id" text,
    "created_at" integer DEFAULT (unixepoch()) NOT NULL,
    "published_at" integer,
    FOREIGN KEY ("theme_id") REFERENCES "themes"("id") ON UPDATE no action ON DELETE set null,
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE no action ON DELETE set null
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "events_slug_unique" ON "events" ("slug")`,
  `CREATE INDEX IF NOT EXISTS "idx_events_status_release" ON "events" ("status", "release_at")`,
  `CREATE INDEX IF NOT EXISTS "idx_events_theme_id" ON "events" ("theme_id")`,
  `CREATE INDEX IF NOT EXISTS "idx_events_organization_id" ON "events" ("organization_id")`,
  `CREATE INDEX IF NOT EXISTS "idx_events_slug" ON "events" ("slug")`,

  // App: faqs
  `CREATE TABLE IF NOT EXISTS "faqs" (
    "id" text PRIMARY KEY NOT NULL,
    "question" text NOT NULL,
    "answer" text NOT NULL,
    "category" text,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" integer DEFAULT (unixepoch()) NOT NULL,
    "updated_at" integer DEFAULT (unixepoch()) NOT NULL
  )`,

  // App: site_config
  `CREATE TABLE IF NOT EXISTS "site_config" (
    "key" text PRIMARY KEY NOT NULL,
    "value" text NOT NULL,
    "updated_at" integer DEFAULT (unixepoch()) NOT NULL
  )`,

  // App: bookmarks
  `CREATE TABLE IF NOT EXISTS "bookmarks" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL,
    "event_id" text NOT NULL,
    "created_at" integer DEFAULT (unixepoch()) NOT NULL,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON UPDATE no action ON DELETE cascade
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "idx_bookmarks_user_event" ON "bookmarks" ("user_id", "event_id")`,
];

/**
 * Ensure all required tables exist in the D1 database.
 *
 * Uses CREATE TABLE / INDEX IF NOT EXISTS so it's safe to call on every
 * boot. Only executes the full schema if the `user` table is missing
 * (i.e. fresh database).
 */
export async function ensureDatabase(d1: D1Database): Promise<void> {
  // Check if database is fresh (no tables yet)
  const { results } = await d1
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user'")
    .all<{ name: string }>();

  if (results.length === 0) {
    // Fresh database — create all tables
    for (const sql of CREATE_STATEMENTS) {
      await d1.prepare(sql).run();
    }
  }

  // Always run patches (safe for both fresh and existing databases)
  for (const sql of PATCH_STATEMENTS) {
    try {
      await d1.prepare(sql).run();
    } catch (err: any) {
      // Ignore "duplicate column" errors from ALTER TABLE
      if (err?.message?.includes('duplicate column')) continue;
      throw err;
    }
  }
}
