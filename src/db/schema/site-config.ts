import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// Primary site config (from D1)
export const siteConfig = sqliteTable('site_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON-serializable string
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch())`),
})

export type SiteConfigRow = typeof siteConfig.$inferSelect
