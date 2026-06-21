import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const announcements = sqliteTable('announcements', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID().replace(/-/g, '')),
  content: text('content', { mode: 'json' })
    .notNull()
    .$type<Record<string, { title: string; body: string }>>(),
  requiresAck: integer('requires_ack', { mode: 'boolean' }).notNull().default(true),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch())`),
})

export type Announcement = typeof announcements.$inferSelect
export type NewAnnouncement = typeof announcements.$inferInsert
