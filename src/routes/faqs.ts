import { Hono } from 'hono'
import { validator, describeRoute } from 'hono-openapi'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { faqs } from '../db/schema/faqs'
import { CacheService } from '../services/cache'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { notFound } from '../lib/errors'

const FAQS_KV_KEY = 'faqs:active'
const FAQS_TTL = 86400 // 1 day KV cache

const faqSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  category: z.string().optional(),
  sortOrder: z.number().int().default(0),
})

export const faqsRoute = new Hono<LeapifyEnv>()

// GET /faqs — public, KV cached 10min
faqsRoute.get(
  '/',
  describeRoute({
    tags: ['FAQs'],
    summary: 'List all active FAQs',
    responses: { 200: { description: 'List of FAQs' } },
  }),
  async (c) => {
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

  const serialized = data.map(({ sortOrder, ...rest }) => rest)
  return c.json({ data: serialized })
})

// POST /faqs — admin
faqsRoute.post(
  '/',
  describeRoute({
    tags: ['FAQs'],
    summary: 'Create a new FAQ (admin)',
    responses: {
      201: { description: 'FAQ created' },
      422: { description: 'Validation error' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  validator('json', faqSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = createDb(c.env.DB)
    const cache = new CacheService(c.env.KV)

    const [created] = await db.insert(faqs).values(body).returning()
    await cache.del(FAQS_KV_KEY)

    return c.json({ data: created }, 201)
  },
)

// PATCH /faqs/:id — admin
faqsRoute.patch(
  '/:id',
  describeRoute({
    tags: ['FAQs'],
    summary: 'Update an FAQ (admin)',
    responses: {
      200: { description: 'FAQ updated' },
      404: { description: 'FAQ not found' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
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

  return c.json({ data: updated })
})

// DELETE /faqs/:id — admin, hard delete
faqsRoute.delete(
  '/:id',
  describeRoute({
    tags: ['FAQs'],
    summary: 'Delete an FAQ (admin)',
    responses: {
      200: { description: 'FAQ deleted' },
      404: { description: 'FAQ not found' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const { id } = c.req.param()
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)

  const [deleted] = await db.delete(faqs).where(eq(faqs.id, id)).returning()

  if (!deleted) throw notFound('FAQ')
  await cache.del(FAQS_KV_KEY)

  return c.json({ data: { deleted: true } })
})
