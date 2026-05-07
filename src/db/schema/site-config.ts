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

// Contentful configuration (stored in site_config as JSON)
export const CONTENTFUL_CONFIG_KEYS = {
  ENABLED: 'contentful.enabled',
  SPACE_ID: 'contentful.spaceId',
  MANAGEMENT_TOKEN: 'contentful.managementToken',
  DEFAULT_SPACE_ID: 'dlsu-events',
} as const

// Contentful sync metadata
export const contentfulConfig = sqliteTable('contentful_config', {
  space_id: text('space_id'),
  contentful_enabled: integer('contentful_enabled').notNull().default(0),
  last_sync_at: integer('last_sync_at'),
  updated_at: integer('updated_at')
    .default(sql`(unixepoch())`)
    .notNull(),
})