import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'
import { events } from './classes'

export const themes = sqliteTable('themes', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID().replace(/-/g, '')),
  name: text('name').notNull().unique(),
  path: text('path').notNull().unique(), // e.g. "/pirates-cove"
  imageUrl: text('image_url'),
  descriptionEn: text('description_en'),
  descriptionFil: text('description_fil'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
})

export const themesRelations = relations(themes, ({ many }) => ({
  events: many(events),
}))

export type Theme = typeof themes.$inferSelect
export type NewTheme = typeof themes.$inferInsert
