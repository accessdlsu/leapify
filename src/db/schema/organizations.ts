import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { relations, sql } from 'drizzle-orm'
import { events } from './classes'

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID().replace(/-/g, '')),
  name: text('name').notNull().unique(),
  acronym: text('acronym').notNull().unique(),
  logoUrl: text('logo_url'),
  link: text('link'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

export const organizationsRelations = relations(organizations, ({ many }) => ({
  events: many(events),
}))

export type Organization = typeof organizations.$inferSelect
export type NewOrganization = typeof organizations.$inferInsert
