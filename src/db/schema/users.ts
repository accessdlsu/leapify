import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const users = sqliteTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID().replace(/-/g, '')),
  /**
   * References Better Auth's `user.id`.
   * Set on first login after the databaseHooks.user.create.after callback fires.
   */
  betterAuthId: text('better_auth_id').notNull().unique(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: text('role', { enum: ['student', 'admin', 'super_admin'] })
    .notNull()
    .default('student'),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch())`),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type UserRole = 'student' | 'admin' | 'super_admin'
