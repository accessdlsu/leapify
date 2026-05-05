import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { events } from '../db/schema/events'
import { CacheService } from '../services/cache'
import { SlotsService } from '../services/slots'
import { GFormsService } from '../services/gforms'
import { ContentfulManagement } from '../services/contentful-management'
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

const CF_EVENT_CT = 'event'

/**
 * Push a single event to Contentful in the background.
 */
async function pushEventToContentful(env: LeapifyEnv['Bindings'], event: typeof events.$inferSelect) {
  if (!ContentfulManagement.isConfigured(env.CONTENTFUL_SPACE_ID, env.CONTENTFUL_MANAGEMENT_TOKEN)) return

  const mgmt = new ContentfulManagement(
    env.CONTENTFUL_SPACE_ID!,
    env.CONTENTFUL_MANAGEMENT_TOKEN!,
    env.CONTENTFUL_ENVIRONMENT,
  )

  try {
    const fields: Record<string, Record<string, unknown>> = {
      title: ContentfulManagement.locale(event.title),
      slug: ContentfulManagement.locale(event.slug),
      isMajor: ContentfulManagement.locale(event.isMajor),
      maxSlots: ContentfulManagement.locale(event.maxSlots),
    }
    if (event.themeId) fields.theme = ContentfulManagement.entryRef(event.themeId)
    if (event.org) fields.org = ContentfulManagement.locale(event.org)
    if (event.venue) fields.venue = ContentfulManagement.locale(event.venue)
    if (event.dateTime) fields.dateTime = ContentfulManagement.locale(event.dateTime)
    if (event.price) fields.price = ContentfulManagement.locale(event.price)
    if (event.backgroundColor) fields.backgroundColor = ContentfulManagement.locale(event.backgroundColor)
    if (event.gformsUrl) fields.gformsUrl = ContentfulManagement.locale(event.gformsUrl)
    if (event.startsAt) fields.startsAt = ContentfulManagement.locale(new Date(event.startsAt * 1000).toISOString())
    if (event.endsAt) fields.endsAt = ContentfulManagement.locale(new Date(event.endsAt * 1000).toISOString())
    if (event.registrationOpensAt) fields.registrationOpensAt = ContentfulManagement.locale(new Date(event.registrationOpensAt * 1000).toISOString())
    if (event.registrationClosesAt) fields.registrationClosesAt = ContentfulManagement.locale(new Date(event.registrationClosesAt * 1000).toISOString())

    // Upload background image to Contentful as an asset
    if (event.backgroundImageUrl && env.FILES) {
      try {
        const imageKey = event.backgroundImageUrl.replace('/uploads/images/', '')
        const object = await env.FILES.get(imageKey)
        if (object) {
          const data = await object.arrayBuffer()
          const contentType = object.httpMetadata?.contentType || 'image/jpeg'
          const fileName = imageKey.split('/').pop() || 'image.jpg'
          const uploadId = await mgmt.uploadFile(fileName, data, contentType)
          const asset = await mgmt.createAssetFromUpload(uploadId, event.title, fileName, contentType)
          fields.image = ContentfulManagement.assetRef(asset.id)
        }
      } catch (err) {
        console.warn(`[Contentful] Failed to upload image for event ${event.id}:`, err)
      }
    }

    await mgmt.upsertEntry(CF_EVENT_CT, event.id, fields)
  } catch (err) {
    console.warn(`[Contentful] Failed to sync event ${event.id}:`, err)
  }
}

const createEventSchema = z.object({
  themeId: z.string().min(1),
  title: z.string().min(1),
  org: z.string().optional(),
  venue: z.string().optional(),
  dateTime: z.string().optional(),
  startsAt: z.number().optional(),
  endsAt: z.number().optional(),
  price: z.string().optional(),
  backgroundColor: z.string().optional(),
  backgroundImageUrl: z.string().url().optional(),
  subtheme: z.string().optional(),
  isMajor: z.boolean().default(false),
  maxSlots: z.number().int().min(0).default(0),
  gformsId: z.string().optional(),
  gformsUrl: z.string().url().optional(),
  releaseAt: z.number().optional(),
  registrationOpensAt: z.number().optional(),
  registrationClosesAt: z.number().optional(),
  contentfulEntryId: z.string().optional(),
  status: z.enum(['draft', 'queued', 'published']).default('draft'),
})

export const eventsRoute = new Hono<LeapifyEnv>()

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// GET /events — public, ETag + 7-day browser cache
eventsRoute.get('/', eventsListRateLimit, async (c) => {
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
    return c.newResponse(null, 304)
  }

  const data = await cache.getOrSet(
    EVENTS_LIST_KV_KEY,
    () =>
      db.query.events.findMany({
        where: eq(events.status, 'published'),
        with: {
          theme: true,
        },
        columns: {
          id: true,
          slug: true,
          themeId: true,
          title: true,
          org: true,
          venue: true,
          dateTime: true,
          startsAt: true,
          endsAt: true,
          price: true,
          backgroundColor: true,
          backgroundImageUrl: true,
          subtheme: true,
          isMajor: true,
          maxSlots: true,
          registeredSlots: true,
          gformsUrl: true,
          registrationOpensAt: true,
          registrationClosesAt: true,
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
eventsRoute.get('/:slug', async (c) => {
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
eventsRoute.get('/:slug/slots', eventsSlotsRateLimit, async (c) => {
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
eventsRoute.post(
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

    c.executionCtx.waitUntil(pushEventToContentful(c.env, created!))

    return c.json({ data: created }, 201)
  },
)

// PATCH /events/:slug — admin only
eventsRoute.patch('/:slug', authMiddleware, adminMiddleware, async (c) => {
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

  c.executionCtx.waitUntil(pushEventToContentful(c.env, updated))

  return c.json({ data: updated })
})
