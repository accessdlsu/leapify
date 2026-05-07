import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { ContentfulManagement } from '../services/contentful-management'
import { ContentfulService } from '../services/contentful'
import { ensureContentTypes, snapshotAllContent, pushToContentful } from '../services/snapshot'
import { authMiddleware, adminMiddleware } from '../auth/middleware'

export const contentfulSyncRoute = new Hono<LeapifyEnv>()

// POST /contentful/sync/trigger — trigger a full Contentful → D1 sync
contentfulSyncRoute.post(
  '/trigger',
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const env = c.env
    const { CONTENTFUL_SPACE_ID, CONTENTFUL_ACCESS_TOKEN, CONTENTFUL_MANAGEMENT_TOKEN, CONTENTFUL_ENVIRONMENT } = env

    if (!CONTENTFUL_SPACE_ID || !CONTENTFUL_ACCESS_TOKEN) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Contentful credentials missing' } }, 400)
    }

    const db = createDb(env.DB)
    const contentful = new ContentfulService(CONTENTFUL_SPACE_ID, CONTENTFUL_ACCESS_TOKEN, CONTENTFUL_ENVIRONMENT)

    try {
      // Ensure content types exist (only when management token is set)
      if (CONTENTFUL_MANAGEMENT_TOKEN) {
        const mgmt = new ContentfulManagement(CONTENTFUL_SPACE_ID, CONTENTFUL_MANAGEMENT_TOKEN, CONTENTFUL_ENVIRONMENT)
        await ensureContentTypes(mgmt)
      }

      // Run snapshot in background — Contentful → D1
      c.executionCtx.waitUntil(
        snapshotAllContent(db, env.FILES, contentful, {}, env.KV)
          .then((r) => console.log('[Contentful] Snapshot complete:', JSON.stringify(r)))
          .catch((err) => console.error('[Contentful] Snapshot failed:', err)),
      )

      return c.json({ message: 'Contentful sync triggered', triggeredAt: Math.floor(Date.now() / 1000) })
    } catch (err: any) {
      console.error('[Contentful] Sync trigger failed:', err)
      return c.json({ error: { code: 'SYNC_FAILED', message: err?.message ?? 'Failed to trigger sync' } }, 500)
    }
  },
)

// POST /contentful/push — push D1 records → Contentful
contentfulSyncRoute.post(
  '/push',
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const env = c.env
    const { CONTENTFUL_SPACE_ID, CONTENTFUL_MANAGEMENT_TOKEN, CONTENTFUL_ENVIRONMENT } = env

    if (!CONTENTFUL_SPACE_ID || !CONTENTFUL_MANAGEMENT_TOKEN) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Contentful management credentials missing' } }, 400)
    }

    const db = createDb(env.DB)
    const mgmt = new ContentfulManagement(CONTENTFUL_SPACE_ID, CONTENTFUL_MANAGEMENT_TOKEN, CONTENTFUL_ENVIRONMENT)

    try {
      c.executionCtx.waitUntil(
        pushToContentful(db, mgmt, {}, env.KV)
          .then((r) => console.log('[Contentful] Push complete:', JSON.stringify(r)))
          .catch((err) => console.error('[Contentful] Push failed:', err)),
      )

      return c.json({ message: 'Contentful push triggered', triggeredAt: Math.floor(Date.now() / 1000) })
    } catch (err: any) {
      console.error('[Contentful] Push trigger failed:', err)
      return c.json({ error: { code: 'SYNC_FAILED', message: err?.message ?? 'Failed to trigger push' } }, 500)
    }
  },
)

// GET /contentful/status — configuration and record counts
contentfulSyncRoute.get(
  '/status',
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const env = c.env
    const db = createDb(env.DB)

    const [[{ themes }], [{ events }], [{ faqs }], [{ orgs }]] = await Promise.all([
      db.all<{ themes: number }>(sql`SELECT count(*) as themes FROM themes`),
      db.all<{ events: number }>(sql`SELECT count(*) as events FROM events`),
      db.all<{ faqs: number }>(sql`SELECT count(*) as faqs FROM faqs`),
      db.all<{ orgs: number }>(sql`SELECT count(*) as orgs FROM organizations`),
    ])

    const isConfigured =
      !!env.CONTENTFUL_SPACE_ID && !!env.CONTENTFUL_ACCESS_TOKEN
    const canPush =
      !!env.CONTENTFUL_SPACE_ID && !!env.CONTENTFUL_MANAGEMENT_TOKEN

    return c.json({
      isConfigured,
      canPush,
      cmsMode: c.get('cmsMode'),
      spaceId: env.CONTENTFUL_SPACE_ID ?? null,
      totals: { themes, events, faqs, organizations: orgs },
    })
  },
)
