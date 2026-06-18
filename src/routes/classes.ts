import { Hono } from 'hono'
import { validator, describeRoute } from 'hono-openapi'
import { z } from 'zod'
import { eq, and, sql } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { events } from '../db/schema/classes'
import { CacheService } from '../services/cache'
import { SlotsService } from '../services/slots'
import { GFormsService } from '../services/gforms'
import { RegistrationsService } from '../services/registrations'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { notFound } from '../lib/errors'
import { reconcileSlots, RECONCILE_LOCK_KEY, RECONCILE_LAST_RUN_KEY } from '../cron/reconcile-slots'
import {
  eventsListRateLimit,
  eventsSlotsRateLimit,
  adminEventsRateLimit,
} from '../lib/middleware/rate-limit'

const EVENTS_LIST_KV_KEY = 'events:list'
const EVENTS_ETAG_KV_KEY = 'events:etag'
const EVENTS_LIST_TTL = 3600 // 1hr KV cache for list

const createEventSchema = z.object({
  themeId: z.string().min(1),
  organizationId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  venue: z.string().optional(),
  dateTime: z.string().optional(),
  price: z.string().optional(),
  backgroundImageUrl: z.string().optional(),
  classCode: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  registrationClosesAt: z.number().optional(),
  isSpotlight: z.boolean().default(false),
  registrationEnabled: z.boolean().default(true),
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

async function uniqueSlug(db: ReturnType<typeof createDb>, base: string): Promise<string> {
  const existing = await db.query.events.findFirst({
    where: eq(events.slug, base),
    columns: { id: true },
  })
  if (!existing) return base

  // Collision — try base-2, base-3, …
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    const clash = await db.query.events.findFirst({
      where: eq(events.slug, candidate),
      columns: { id: true },
    })
    if (!clash) return candidate
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeEvent(event: any) {
  if (!event) return event
  const { dateTime, ...rest } = event
  return { ...rest, date: dateTime }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeEvents(events: any[]) {
  return events.map(serializeEvent)
}

// GET /events/admin — admin only, returns all events regardless of status
classesRoute.get(
  '/admin',
  describeRoute({
    tags: ['Events'],
    summary: 'List all events (admin)',
    responses: { 200: { description: 'List of all events' } },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const db = createDb(c.env.DB)
  const data = await db.query.events.findMany({
    with: { theme: true, organization: true },
    orderBy: (e, { desc }) => [desc(e.createdAt)],
  })
  return c.json({ data: serializeEvents(data) })
})

// POST /events/admin/publish — admin only, batch publish queued events
classesRoute.post(
  '/admin/publish',
  describeRoute({
    tags: ['Events'],
    summary: 'Batch publish queued events',
    responses: {
      200: { description: 'Events published successfully' },
      400: { description: 'Missing event IDs' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
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
classesRoute.get(
  '/',
  describeRoute({
    tags: ['Events'],
    summary: 'List published events',
    responses: { 200: { description: 'List of published events with themes' } },
  }),
  eventsListRateLimit,
  async (c) => {
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
          description: true,
          venue: true,
          dateTime: true,
          price: true,
          backgroundImageUrl: true,
          classCode: true,
          startTime: true,
          endTime: true,
          registrationClosesAt: true,
          isSpotlight: true,
          registrationEnabled: true,
          maxSlots: true,
          gformsUrl: true,
        },
      }),
    EVENTS_LIST_TTL,
  )

  c.header('ETag', etag)
  return c.json({ data: serializeEvents(data) })
})

// GET /slots — all events slot availability in one shot
classesRoute.get(
  '/slots',
  describeRoute({
    tags: ['Events'],
    summary: 'Get slot availability for all events',
    responses: {
      200: { description: 'Map of slug → SlotInfo' },
    },
  }),
  eventsSlotsRateLimit,
  async (c) => {
    const db = createDb(c.env.DB)
    const slotsService = new SlotsService(db)
    const all = await slotsService.getAllSlots()
    c.header('Cache-Control', 'public, max-age=3, stale-while-revalidate=3')
    return c.json({ data: all })
  },
)

// GET /reconcile/status — admin only, returns last cron run time and in-progress status
classesRoute.get(
  '/reconcile/status',
  describeRoute({
    tags: ['Events'],
    summary: 'Get slot reconciliation status',
    responses: {
      200: { description: 'Reconcile status' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const cache = new CacheService(c.env.KV)
    const [lock, lastRun] = await Promise.all([
      cache.get<string>(RECONCILE_LOCK_KEY),
      cache.get<string>(RECONCILE_LAST_RUN_KEY),
    ])
    return c.json({
      data: {
        inProgress: lock !== null,
        lastReconcileAt: lastRun ? parseInt(lastRun, 10) : null,
      },
    })
  },
)

// POST /reconcile — admin only, triggers full slot reconcile across all events
classesRoute.post(
  '/reconcile',
  describeRoute({
    tags: ['Events'],
    summary: 'Trigger full slot reconciliation',
    responses: {
      200: { description: 'Reconciliation complete' },
      409: { description: 'Reconciliation already in progress' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const cache = new CacheService(c.env.KV)
    const lock = await cache.get<string>(RECONCILE_LOCK_KEY)
    if (lock) {
      return c.json({ error: { code: 'RECONCILE_IN_PROGRESS', message: 'Reconciliation is already in progress.' } }, 409)
    }
    await reconcileSlots(c.env)
    return c.json({ data: { ok: true } })
  },
)

// GET /events/:slug
classesRoute.get(
  '/:slug',
  describeRoute({
    tags: ['Events'],
    summary: 'Get event by slug',
    responses: {
      200: { description: 'Event details' },
      404: { description: 'Event not found' },
    },
  }),
  async (c) => {
  const { slug } = c.req.param()
  const db = createDb(c.env.DB)

  const event = await db.query.events.findFirst({
    where: and(eq(events.slug, slug), eq(events.status, 'published')),
    with: {
      theme: true,
    },
  })

  if (!event) throw notFound('Event')

  const { registeredSlots: _, ...rest } = event
  return c.json({ data: serializeEvent(rest) })
})

// GET /events/:slug/slots — real-time, CF Cache 5s
classesRoute.get(
  '/:slug/slots',
  describeRoute({
    tags: ['Events'],
    summary: 'Get event slot availability',
    responses: {
      200: { description: 'Slot availability info' },
      404: { description: 'Event not found' },
    },
  }),
  eventsSlotsRateLimit,
  async (c) => {
  const { slug } = c.req.param()
  const db = createDb(c.env.DB)
  const slotsService = new SlotsService(db)

  const info = await slotsService.getSlots(slug)
  if (!info) throw notFound('Event')

  // CF edge cache: all 30k users share this cached response for 3s
  c.header('Cache-Control', 'public, max-age=3, stale-while-revalidate=3')

  return c.json({ data: info })
})

// POST /events/:slug/reconcile — admin only, corrects slot count for one event
classesRoute.post(
  '/:slug/reconcile',
  describeRoute({
    tags: ['Events'],
    summary: 'Reconcile event slot count with Google Forms',
    responses: {
      200: { description: 'Slot count reconciled' },
      400: { description: 'No gformsId set' },
      404: { description: 'Event not found' },
      502: { description: 'Google Forms API error' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const { slug } = c.req.param()
  const db = createDb(c.env.DB)
  const gforms = new GFormsService(c.env.GFORMS_SERVICE_ACCOUNT_JSON)
  const slots = new SlotsService(db)
  const regs = new RegistrationsService(db)

  const event = await db.query.events.findFirst({
    where: eq(events.slug, slug),
    columns: { id: true, gformsId: true },
  })
  if (!event) throw notFound('Event')
  if (!event.gformsId) return c.json({ error: 'No gformsId set for this event' }, 400)

  try {
    const responses = await gforms.getAllResponses(event.gformsId)
    const googleCount = responses.length
    await slots.correctCount(slug, googleCount)

    // Deduplicate by email, keeping the latest submission
    const seen = new Map<string, string>()
    for (const r of responses) {
      if (r.respondentEmail) {
        const existing = seen.get(r.respondentEmail)
        if (!existing || r.lastSubmittedTime > existing) {
          seen.set(r.respondentEmail, r.lastSubmittedTime)
        }
      }
    }

    const respondents = Array.from(seen.entries())
      .map(([email, submittedAt]) => ({ email, submittedAt }))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))

    // Sync registrations table: insert new, delete removed
    await regs.syncRespondents(
      event.id,
      respondents.map((r) => ({
        email: r.email,
        submittedAt: Math.floor(new Date(r.submittedAt).getTime() / 1000),
      })),
    )

    return c.json({ data: { registeredSlots: googleCount, respondents } })
  } catch (err: any) {
    const message = err?.message ?? 'Failed to fetch from Google Forms API'
    return c.json({ error: { code: 'GFORMS_API_ERROR', message } }, 502)
  }
})

// POST /events — admin only
classesRoute.post(
  '/',
  describeRoute({
    tags: ['Events'],
    summary: 'Create a new event',
    responses: {
      201: { description: 'Event created successfully' },
      422: { description: 'Validation error' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  adminEventsRateLimit,
  validator('json', createEventSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = createDb(c.env.DB)
    const cache = new CacheService(c.env.KV)

    const slug = await uniqueSlug(db, generateSlug(body.title))

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

    return c.json({ data: serializeEvent(created) }, 201)
  },
)

// PATCH /events/:slug — admin only
classesRoute.patch(
  '/:slug',
  describeRoute({
    tags: ['Events'],
    summary: 'Update an event',
    responses: {
      200: { description: 'Event updated successfully' },
      404: { description: 'Event not found' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const { slug } = c.req.param()
  const raw = await c.req.json<Partial<z.infer<typeof createEventSchema>>>()
  // Normalize empty strings to null for nullable FK/optional columns
  const body = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v === '' ? null : v])
  ) as typeof raw
  const db = createDb(c.env.DB)
  const cache = new CacheService(c.env.KV)

  const [updated] = await db
    .update(events)
    .set(body)
    .where(eq(events.slug, slug))
    .returning()

  if (!updated) throw notFound('Event')

  await Promise.all([
    cache.del(EVENTS_LIST_KV_KEY),
    cache.del(EVENTS_ETAG_KV_KEY),
  ])

  return c.json({ data: serializeEvent(updated) })
})

// DELETE /events/:slug — admin only
classesRoute.delete(
  '/:slug',
  describeRoute({
    tags: ['Events'],
    summary: 'Delete an event',
    responses: {
      204: { description: 'Event deleted' },
      404: { description: 'Event not found' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
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
