import { Hono } from "hono";
import type { LeapifyEnv, SiteConfigKey, SiteConfigMap } from "../types";
import { createDb } from "../db";
import { siteConfig } from "../db/schema/site-config";
import { authMiddleware, adminMiddleware } from "../auth/middleware";
import { ContentfulManagement } from "../services/contentful-management";
import { ensureContentTypes, pushToContentful } from "../services/snapshot";
import { serviceUnavailable } from "../lib/errors";

export const siteConfigRoute = new Hono<LeapifyEnv>();

// GET /config — public
siteConfigRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);

  const rows = await db.query.siteConfig.findMany();
  const config = Object.fromEntries(
    rows.map((r) => [r.key, JSON.parse(r.value)]),
  ) as Partial<SiteConfigMap>;

  return c.json({
    data: {
      comingSoonUntil: config.coming_soon_until ?? null,
      siteEndsAt: config.site_ends_at ?? null,
      siteName: config.site_name ?? null,
      registrationGloballyOpen: config.registration_globally_open ?? true,
      maintenanceMode: config.maintenance_mode ?? false,
      now: Math.floor(Date.now() / 1000),
    },
  });
});

// PATCH /config/:key — admin only
siteConfigRoute.patch("/:key", authMiddleware, adminMiddleware, async (c) => {
  const key = c.req.param("key") as SiteConfigKey;
  const { value } = await c.req.json<{ value: SiteConfigMap[typeof key] }>();

  const db = createDb(c.env.DB);
  const now = Math.floor(Date.now() / 1000);

  await db
    .insert(siteConfig)
    .values({ key, value: JSON.stringify(value), updatedAt: now })
    .onConflictDoUpdate({
      target: siteConfig.key,
      set: { value: JSON.stringify(value), updatedAt: now },
    });

  // Write-through to KV so the maintenance-mode middleware can read it
  // without a D1 round-trip on every request. TTL 10 min — admin must
  // wait at most 10 min for changes to fully propagate across all edges.
  await c.env.KV.put(`config:${key}`, JSON.stringify(value), {
    expirationTtl: 600,
  });

  return c.json({ data: { key, value } });
});

// POST /config/sync-content — admin only
// Auto-generates content types in Contentful if missing, then pushes all D1 content.
siteConfigRoute.post("/sync-content", authMiddleware, adminMiddleware, async (c) => {
  if (!ContentfulManagement.isConfigured(c.env.CONTENTFUL_SPACE_ID, c.env.CONTENTFUL_MANAGEMENT_TOKEN)) {
    throw serviceUnavailable('Contentful Management API credentials not configured.')
  }

  const mgmt = new ContentfulManagement(
    c.env.CONTENTFUL_SPACE_ID!,
    c.env.CONTENTFUL_MANAGEMENT_TOKEN!,
    c.env.CONTENTFUL_ENVIRONMENT,
  )

  const db = createDb(c.env.DB)

  // Auto-generate content types if they don't exist
  await ensureContentTypes(mgmt, {})

  // Push all D1 content to Contentful
  const result = await pushToContentful(db, mgmt, {})

  return c.json({ data: result })
});
