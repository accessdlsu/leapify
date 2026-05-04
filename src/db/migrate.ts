/**
 * Auto-migration helper for D1 databases.
 *
 * When enabled, runs Drizzle migrations on the first request if the
 * database has no tables yet. Safe to call on every boot — Drizzle's
 * migrate() is idempotent and tracks applied migrations in a internal table.
 *
 * Import from 'leapify' — server-only.
 *
 * @example
 * // worker.ts
 * import { createLeapify } from 'leapify'
 *
 * export default createLeapify({ autoMigrate: true })
 */

import { migrate } from "drizzle-orm/d1/migrator";
import { createDb } from "./index";

/**
 * Run pending Drizzle migrations against a D1 database.
 *
 * This is idempotent — calling it multiple times is safe. Only unapplied
 * migrations will be executed.
 *
 * @param d1 - The D1 database binding.
 * @param migrationsFolder - Path to the migrations folder relative to the
 *   worker bundle. Defaults to "./drizzle" which works for the standalone
 *   worker build. npm module consumers should set this to their own
 *   migrations directory.
 */
export async function ensureDatabase(
  d1: D1Database,
  migrationsFolder = "./drizzle",
): Promise<void> {
  const db = createDb(d1);
  await migrate(db, { migrationsFolder });
}
