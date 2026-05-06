import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { faqs } from '../db/schema/faqs'
import { CacheService } from '../services/cache'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { notFound } from '../lib/errors'
import { ContentfulManagement } from '../services/contentful-management'

const FAQS_KV_KEY = 'faqs:active'
const FAQS_TTL = 600 // 10 min
const CF_FAQ_CT = 'faq'

const faqSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  category: z.string().optional(),
  sortOrder: z.number().int().default(0),
})

export const faqsRoute = new Hono<LeapifyEnv>()

/**
 * Push a single FAQ entry to Contentful in the background.
 * No-op if Contentful Management API is not configured.
 */
async function pushFaqToContentful(env: LeapifyEnv['Bindings'], faq: typeof faqs.$inferSelect) {
  console.log('[Contentful] pushFaqToContentful called for FAQ:', faq.id)
  if (!ContentfulManagement.isConfigured(env.CONTENTFUL_SPACE_ID, env.CONTENTFUL_MANAGEMENT_TOKEN)) {
    console.log('[Contentful] Skipping FAQ push — Management API not configured',
      'SPACE_ID:', !!env.CONTENTFUL_SPACE_ID, 'MGMT_TOKEN:', !!env.CONTENTFUL_MANAGEMENT_TOKEN)
    return
  }

  const mgmt = new ContentfulManagement(
    env.CONTENTFUL_SPACE_ID!,
    env.CONTENTFUL_MANAGEMENT_TOKEN!,
    env.CONTENTFUL_ENVIRONMENT,
  )

  try {
    await mgmt.upsertEntry(CF_FAQ_CT, faq.id, {
      'en-US': { question: faq.question },
      answer: { 'en-US': faq.answer },
      category: { 'en-US': faq.category },
      sortOrder: { 'en-US': faq.sortOrder },
    })
    console.log(`[Contentful] Synced FAQ ${faq.id} successfully`)
  } catch (err) {
    console.warn(`[Contentful] Failed to sync FAQ ${faq.id}:`, err)
  }
}

// GET /faqs — public, KV cached 10min
faqsRoute.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)

  const data = await cache.getOrSet(
    FAQS_KV_KEY,
    () =>
      db.query.faqs.findMany({
        orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
      }),
    FAQS_TTL,
  )

  return c.json({ data })
})

// POST /faqs — admin
faqsRoute.post(
  '/',
  authMiddleware,
  adminMiddleware,
  zValidator('json', faqSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = createDb(c.env.DB)
    const cache = new CacheService(c.env.KV)

    const [created] = await db.insert(faqs).values(body).returning()
    await cache.del(FAQS_KV_KEY)

    // Push to Contentful in background (non-blocking, keeps execution context alive)
    c.executionCtx.waitUntil(pushFaqToContentful(c.env, created))

    return c.json({ data: created }, 201)
  },
)

// PATCH /faqs/:id — admin
faqsRoute.patch('/:id', authMiddleware, adminMiddleware, async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json<Partial<z.infer<typeof faqSchema>>>()
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)
  const now = Math.floor(Date.now() / 1000)

  const [updated] = await db
    .update(faqs)
    .set({ ...body, updatedAt: now })
    .where(eq(faqs.id, id))
    .returning()

  if (!updated) throw notFound('FAQ')
  await cache.del(FAQS_KV_KEY)

  // Push to Contentful in background (non-blocking, keeps execution context alive)
  c.executionCtx.waitUntil(pushFaqToContentful(c.env, updated))

  return c.json({ data: updated })
})

// DELETE /faqs/:id — admin, hard delete
faqsRoute.delete('/:id', authMiddleware, adminMiddleware, async (c) => {
  const { id } = c.req.param()
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)

  const [deleted] = await db.delete(faqs).where(eq(faqs.id, id)).returning()

  if (!deleted) throw notFound('FAQ')
  await cache.del(FAQS_KV_KEY)

  return c.json({ data: { deleted: true } })
})
