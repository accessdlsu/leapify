import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { LeapifyEnv, SiteConfigKey, SiteConfigMap } from '../types'
import { createDb } from '../db'
import { siteConfig } from '../db/schema/site-config'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { forbidden } from '../lib/errors'

export const siteConfigRoute = new Hono<LeapifyEnv>()

// GET /config — public
siteConfigRoute.get(
  '/',
  describeRoute({
    tags: ['Site Config'],
    summary: 'Get public site configuration',
    security: [],
    responses: { 200: { description: 'Site configuration values' } },
  }),
  async (c) => {
  const db = createDb(c.env.DB)

  const rows = await db.query.siteConfig.findMany()
  const config = Object.fromEntries(
    rows.map((r) => [r.key, JSON.parse(r.value)])
  ) as Partial<SiteConfigMap>

  return c.json({
    data: {
      comingSoonUntil: config.coming_soon_until ?? null,
      siteEndsAt: config.site_ends_at ?? null,
      siteName: config.site_name ?? null,
      registrationGloballyOpen: config.registration_globally_open ?? true,
      maintenanceMode: config.maintenance_mode ?? false,
      allowedOrigins: config.allowed_origins ?? null,
      now: Math.floor(Date.now() / 1000)
    }
  })
})

// PATCH /config/:key — admin only (allowed_origins is super_admin only)
siteConfigRoute.patch(
  '/:key',
  describeRoute({
    tags: ['Site Config'],
    summary: 'Update a site configuration key (admin)',
    responses: {
      200: { description: 'Config updated' },
      403: { description: 'Super admin required for this key' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const key = c.req.param('key') as SiteConfigKey
  const { value } = await c.req.json<{ value: SiteConfigMap[typeof key] }>()

  if (key === 'allowed_origins') {
    const user = c.get('user')
    if (!user || user.role !== 'super_admin') {
      throw forbidden('Super Admin access required to change allowed origins')
    }
  }

  const db = createDb(c.env.DB)
  const now = Math.floor(Date.now() / 1000)

  await db
    .insert(siteConfig)
    .values({ key, value: JSON.stringify(value), updatedAt: now })
    .onConflictDoUpdate({
      target: siteConfig.key,
      set: { value: JSON.stringify(value), updatedAt: now }
    })

  // Write-through to KV so the maintenance-mode / CORS middlewares can read it
  // without a D1 round-trip on every request. TTL 1 day — KV is the fast cache;
  // D1 is the durable source of truth used as fallback when KV expires.
  await c.env.KV.put(`config:${key}`, JSON.stringify(value), {
    expirationTtl: 86400
  })

  return c.json({ data: { key, value } })
})
