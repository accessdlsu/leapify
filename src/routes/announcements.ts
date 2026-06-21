import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { eq } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { announcements } from '../db/schema/announcements'
import { CacheService } from '../services/cache'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { notFound } from '../lib/errors'

const CACHE_KEY = 'announcements:active'
const CACHE_TTL = 300 // 5 min

export const announcementsRoute = new Hono<LeapifyEnv>()

// GET /announcements — public, returns active announcements newest-first
announcementsRoute.get(
  '/',
  describeRoute({
    tags: ['Announcements'],
    summary: 'List active announcements',
    security: [],
    responses: { 200: { description: 'Active announcements' } },
  }),
  async (c) => {
    const db = createDb(c.env.DB)
    const cache = new CacheService(c.env.KV)

    const data = await cache.getOrSet(
      CACHE_KEY,
      () => db.query.announcements.findMany({
        where: (t, { eq }) => eq(t.isActive, true),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      }),
      CACHE_TTL,
    )

    return c.json({ data })
  },
)

// GET /announcements/admin — admin, all announcements
announcementsRoute.get(
  '/admin',
  describeRoute({
    tags: ['Announcements'],
    summary: 'List all announcements (admin)',
    responses: { 200: { description: 'All announcements' } },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const db = createDb(c.env.DB)
    const data = await db.query.announcements.findMany({
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    })
    return c.json({ data })
  },
)

// POST /announcements — admin create
announcementsRoute.post(
  '/',
  describeRoute({
    tags: ['Announcements'],
    summary: 'Create announcement (admin)',
    responses: { 201: { description: 'Created' } },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const body = await c.req.json<{ content: Record<string, { title: string; body: string }>; requiresAck?: boolean; isActive?: boolean }>()
    const db = createDb(c.env.DB)
    const cache = new CacheService(c.env.KV)

    const [created] = await db.insert(announcements).values({
      content: body.content,
      requiresAck: body.requiresAck ?? true,
      isActive: body.isActive ?? true,
    }).returning()

    await cache.del(CACHE_KEY)
    return c.json({ data: created }, 201)
  },
)

// PATCH /announcements/:id — admin update
announcementsRoute.patch(
  '/:id',
  describeRoute({
    tags: ['Announcements'],
    summary: 'Update announcement (admin)',
    responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const { id } = c.req.param()
    const body = await c.req.json<Partial<{ content: Record<string, { title: string; body: string }>; requiresAck: boolean; isActive: boolean }>>()
    const db = createDb(c.env.DB)
    const cache = new CacheService(c.env.KV)
    const now = Math.floor(Date.now() / 1000)

    const [updated] = await db
      .update(announcements)
      .set({ ...body, updatedAt: now })
      .where(eq(announcements.id, id))
      .returning()

    if (!updated) throw notFound('Announcement')
    await cache.del(CACHE_KEY)
    return c.json({ data: updated })
  },
)

// DELETE /announcements/:id — admin
announcementsRoute.delete(
  '/:id',
  describeRoute({
    tags: ['Announcements'],
    summary: 'Delete announcement (admin)',
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const { id } = c.req.param()
    const db = createDb(c.env.DB)
    const cache = new CacheService(c.env.KV)

    const [deleted] = await db.delete(announcements).where(eq(announcements.id, id)).returning()
    if (!deleted) throw notFound('Announcement')
    await cache.del(CACHE_KEY)
    return c.json({ data: { deleted: true } })
  },
)
