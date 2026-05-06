import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const faqs = sqliteTable('faqs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID().replace(/-/g, '')),
  question: text('question').notNull(),
  answer: text('answer').notNull(),      // markdown supported
  category: text('category'),            // optional grouping, e.g. "Registration"
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch())`),
})

export type Faq = typeof faqs.$inferSelect
export type NewFaq = typeof faqs.$inferInsert
