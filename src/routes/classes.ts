import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, sql } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { events } from '../db/schema/classes'
import { CacheService } from '../services/cache'
import { SlotsService } from '../services/slots'
import { GFormsService } from '../services/gforms'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { notFound } from '../lib/errors'
import {
  eventsListRateLimit,
  eventsSlotsRateLimit,
  adminEventsRateLimit,
} from '../lib/middleware/rate-limit'

const EVENTS_LIST_KV_KEY = 'events:list'
const EVENTS_ETAG_KV_KEY = 'events:etag'
const EVENTS_LIST_TTL = 300 // 5 min KV cache for list

const createEventSchema = z.object({
  themeId: z.string().min(1),
  organizationId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  venue: z.string().optional(),
  dateTime: z.string().optional(),
  price: z.string().optional(),
  backgroundImageUrl: z.string().url().optional(),
  classCode: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  registrationClosesAt: z.number().optional(),
  isSpotlight: z.boolean().default(false),
  maxSlots: z.number().int().min(0).default(0),
  gformsId: z.string().optional(),
  gformsUrl: z.string().url().optional(),
  gformsEditorUrl: z.string().url().optional(),
  releaseAt: z.number().optional(),
  status: z.enum(['draft', 'queued', 'published']).default('draft'),
})

export const classesRoute = new Hono<LeapifyEnv>()

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// GET /events/admin — admin only, returns all events regardless of status
classesRoute.get('/admin', authMiddleware, adminMiddleware, async (c) => {
  const db = createDb(c.env.DB)
  const data = await db.query.events.findMany({
    with: { theme: true, organization: true },
    orderBy: (e, { desc }) => [desc(e.createdAt)],
  })
  return c.json({ data })
})

// POST /events/admin/publish — admin only, batch publish queued events
classesRoute.post('/admin/publish', authMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.json<{ ids: string[]; releaseAt?: number }>()
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)

  if (!body.ids?.length) {
    return c.json({ error: 'ids are required' }, 400)
  }

  if (body.releaseAt) {
    // Schedule for later
    await db
      .update(events)
      .set({ releaseAt: body.releaseAt, status: 'queued' })
      .where(
        sql`${events.id} IN (${sql.join(
          body.ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
  } else {
    // Publish now
    await db
      .update(events)
      .set({ status: 'published', publishedAt: sql`(unixepoch())` })
      .where(
        sql`${events.id} IN (${sql.join(
          body.ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
  }

  await Promise.all([
    cache.del(EVENTS_LIST_KV_KEY),
    cache.del(EVENTS_ETAG_KV_KEY),
  ])

  return c.json({ data: { updated: body.ids.length } })
})

// GET /events — public, ETag + 7-day browser cache
classesRoute.get('/', eventsListRateLimit, async (c) => {
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)

  // Generate ETag from latest publishedAt timestamp
  const [latest] = await db
    .select({ max: events.publishedAt })
    .from(events)
    .where(eq(events.status, 'published'))
    .limit(1)

  const etag = await cache.getOrSet(
    EVENTS_ETAG_KV_KEY,
    () => cache.generateETag(String(latest?.max ?? '0')),
    300,
  )

  // Handle conditional GET
  const ifNoneMatch = c.req.header('If-None-Match')
  if (ifNoneMatch === etag) {
    return c.body(null, 304)
  }

  const data = await cache.getOrSet(
    EVENTS_LIST_KV_KEY,
    () =>
      db.query.events.findMany({
        where: eq(events.status, 'published'),
        with: {
          theme: true,
          organization: true,
        },
        columns: {
          id: true,
          slug: true,
          themeId: true,
          organizationId: true,
          title: true,
          venue: true,
          dateTime: true,
          price: true,
          backgroundImageUrl: true,
          classCode: true,
          startTime: true,
          endTime: true,
          registrationClosesAt: true,
          isSpotlight: true,
          maxSlots: true,
          registeredSlots: true,
          gformsUrl: true,
          gformsEditorUrl: true,
          publishedAt: true,
        },
      }),
    EVENTS_LIST_TTL,
  )

  c.header('ETag', etag)
  c.header(
    'Cache-Control',
    'public, max-age=604800, stale-while-revalidate=86400',
  ) // 7 days
  return c.json({ data })
})

// GET /events/:slug
classesRoute.get('/:slug', async (c) => {
  const { slug } = c.req.param()
  const db = createDb(c.env.DB)

  const event = await db.query.events.findFirst({
    where: and(eq(events.slug, slug), eq(events.status, 'published')),
    with: {
      theme: true,
    },
  })

  if (!event) throw notFound('Event')

  return c.json({ data: event })
})

// GET /events/:slug/slots — real-time, CF Cache 5s
classesRoute.get('/:slug/slots', eventsSlotsRateLimit, async (c) => {
  const { slug } = c.req.param()
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)
  const slotsService = new SlotsService(db, cache)

  const info = await slotsService.getSlots(slug)
  if (!info) throw notFound('Event')

  // CF edge cache: all 30k users share this cached response for 5s
  c.header('Cache-Control', 'public, max-age=5, stale-while-revalidate=5')

  return c.json({ data: info })
})

// POST /events — admin only
classesRoute.post(
  '/',
  authMiddleware,
  adminMiddleware,
  adminEventsRateLimit,
  zValidator('json', createEventSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = createDb(c.env.DB)
    const cache = new CacheService(c.env.KV)

    const slug = generateSlug(body.title)

    const [created] = await db.insert(events).values({ ...body, slug }).returning()

    // If publishing immediately, create a Google Forms Watch
    if (
      body.status === 'published' &&
      body.gformsId &&
      c.env.GFORMS_SERVICE_ACCOUNT_JSON
    ) {
      const webhookUrl = c.get('gformsWebhookUrl')
      if (webhookUrl) {
        const gforms = new GFormsService(c.env.GFORMS_SERVICE_ACCOUNT_JSON)
        try {
          const watch = await gforms.createWatch(body.gformsId, webhookUrl)
          const expiry = Math.floor(
            new Date(watch.expireTime ?? '').getTime() / 1000,
          )
          await db
            .update(events)
            .set({ watchId: watch.watchId, watchExpiresAt: expiry })
            .where(eq(events.id, created!.id))
        } catch (err) {
          console.error('[events] Failed to create Watch:', err)
        }
      } else {
        console.warn(
          '[events] gformsWebhookUrl not configured \u2014 Watch not created. Pass gformsWebhookUrl to createLeapify().',
        )
      }
    }

    // Invalidate list cache
    await Promise.all([
      cache.del(EVENTS_LIST_KV_KEY),
      cache.del(EVENTS_ETAG_KV_KEY),
    ])

    return c.json({ data: created }, 201)
  },
)

// PATCH /events/:slug — admin only
classesRoute.patch('/:slug', authMiddleware, adminMiddleware, async (c) => {
  const { slug } = c.req.param()
  const body = await c.req.json<Partial<z.infer<typeof createEventSchema>>>()
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)

  let newSlug: string | undefined
  if (body.title) {
    newSlug = generateSlug(body.title)
  }

  const [updated] = await db
    .update(events)
    .set(newSlug ? { ...body, slug: newSlug } : body)
    .where(eq(events.slug, slug))
    .returning()

  if (!updated) throw notFound('Event')

  await Promise.all([
    cache.del(EVENTS_LIST_KV_KEY),
    cache.del(EVENTS_ETAG_KV_KEY),
  ])

  return c.json({ data: updated })
})

// DELETE /events/:slug — admin only
classesRoute.delete('/:slug', authMiddleware, adminMiddleware, async (c) => {
  const { slug } = c.req.param()
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)

  const [deleted] = await db.delete(events).where(eq(events.slug, slug)).returning()

  if (!deleted) throw notFound('Event')

  await Promise.all([
    cache.del(EVENTS_LIST_KV_KEY),
    cache.del(EVENTS_ETAG_KV_KEY),
  ])

  return c.body(null, 204)
})
