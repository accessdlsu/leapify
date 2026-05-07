/**
 * Contentful → D1 + R2 snapshot service.
 *
 * Pulls published content from Contentful, downloads images into R2
 * (with SHA-256 dedup to skip unchanged files), and upserts rows into D1.
 * Caches fetched Contentful entries in KV to reduce API strain.
 *
 * Called by the `snapshot_content` queue handler and the admin sync endpoint.
 */

import type { R2Bucket, KVNamespace } from '@cloudflare/workers-types'
import { eq } from 'drizzle-orm'
import { ContentfulService, type ContentfulEntry, type ContentfulAsset } from './contentful'
import { ContentfulManagement } from './contentful-management'
import type { LeapifyDb } from '../db'
import { themes } from '../db/schema/themes'
import { events } from '../db/schema/classes'
import { faqs } from '../db/schema/faqs'
import { organizations } from '../db/schema/organizations'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SnapshotConfig {
  eventTypeId: string
  themeTypeId: string
  faqTypeId: string
  organizationTypeId: string
  fields: {
    event: {
      title: string
      slug: string
      theme: string
      organization: string
      venue: string
      date: string
      startTime: string
      endTime: string
      price: string
      image: string
      isSpotlight: string
      maxSlots: string
      gformsUrl: string
      gformsEditorUrl: string
      registrationClosesAt: string
      classCode: string
    }
    theme: {
      name: string
      path: string
    }
    faq: {
      question: string
      answer: string
      category: string
      sortOrder: string
    }
    organization: {
      name: string
      acronym: string
      logoUrl: string
      link: string
    }
    siteConfig: {
      key: string
      value: string
    }
  }
}

export interface SnapshotResult {
  themesSynced: number
  eventsSynced: number
  faqsSynced: number
  organizationsSynced: number
  imagesUploaded: number
  imagesSkipped: number
  errors: string[]
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_FIELDS: SnapshotConfig['fields'] = {
  event: {
    title: 'title',
    slug: 'slug',
    theme: 'theme',
    organization: 'organization',
    venue: 'venue',
    date: 'date',
    startTime: 'startTime',
    endTime: 'endTime',
    price: 'price',
    image: 'image',
    isSpotlight: 'isSpotlight',
    maxSlots: 'maxSlots',
    gformsUrl: 'gformsUrl',
    gformsEditorUrl: 'gformsEditorUrl',
    registrationClosesAt: 'registrationClosesAt',
    classCode: 'classCode',
  },
  theme: {
    name: 'name',
    path: 'path',
  },
  faq: {
    question: 'question',
    answer: 'answer',
    category: 'category',
    sortOrder: 'sortOrder',
  },
  organization: {
    name: 'name',
    acronym: 'acronym',
    logoUrl: 'logoUrl',
    link: 'link',
  },
  siteConfig: {
    key: 'key',
    value: 'value',
  },
}

// ─── Public API ──────────────────────────────────────────────────────────────

const CONTENTFUL_CACHE_PREFIX = 'contentful:cache'
const CONTENTFUL_CACHE_TTL = 300 // 5 minutes

/**
 * Run a full Contentful → D1 + R2 snapshot.
 *
 * 1. Fetches all themes, events, and FAQs from Contentful (or KV cache).
 * 2. For each image asset: downloads from Contentful CDN, computes SHA-256,
 *    checks R2 for an existing object with the same SHA, and skips the upload
 *    if unchanged (dedup).
 * 3. Upserts all entries into D1.
 * 4. Caches fetched Contentful entries in KV for 5 minutes.
 */
export async function snapshotAllContent(
  db: LeapifyDb,
  bucket: R2Bucket | undefined,
  contentful: ContentfulService,
  config: Partial<SnapshotConfig> = {},
  kv?: KVNamespace,
): Promise<SnapshotResult> {
  const mergedConfig: SnapshotConfig = {
    eventTypeId: config.eventTypeId ?? 'event',
    themeTypeId: config.themeTypeId ?? 'theme',
    faqTypeId: config.faqTypeId ?? 'faq',
    organizationTypeId: config.organizationTypeId ?? 'organization',
    fields: {
      event: { ...DEFAULT_FIELDS.event, ...config.fields?.event },
      theme: { ...DEFAULT_FIELDS.theme, ...config.fields?.theme },
      faq: { ...DEFAULT_FIELDS.faq, ...config.fields?.faq },
      organization: { ...DEFAULT_FIELDS.organization, ...config.fields?.organization },
      siteConfig: { ...DEFAULT_FIELDS.siteConfig, ...config.fields?.siteConfig },
    },
  }

  const result: SnapshotResult = {
    themesSynced: 0,
    eventsSynced: 0,
    faqsSynced: 0,
    organizationsSynced: 0,
    imagesUploaded: 0,
    imagesSkipped: 0,
    errors: [],
  }

  // Fetch all assets once (shared across entries for image resolution)
  let allAssets: ContentfulAsset[] = []
  if (bucket) {
    try {
      allAssets = await contentful.getAssets()
    } catch (err) {
      result.errors.push(`Failed to fetch assets: ${err}`)
    }
  }

  // 1. Sync themes (check KV cache first)
  try {
    const cacheKey = `${CONTENTFUL_CACHE_PREFIX}:themes`
    let themeEntries: ContentfulEntry[]
    if (kv) {
      const cached = await kv.get<ContentfulEntry[]>(cacheKey, 'json')
      if (cached) {
        themeEntries = cached
      } else {
        themeEntries = await contentful.getEntries(mergedConfig.themeTypeId)
        await kv.put(cacheKey, JSON.stringify(themeEntries), { expirationTtl: CONTENTFUL_CACHE_TTL })
      }
    } else {
      themeEntries = await contentful.getEntries(mergedConfig.themeTypeId)
    }
    result.themesSynced = await syncThemes(db, themeEntries, mergedConfig)
  } catch (err) {
    result.errors.push(`Themes sync failed: ${err}`)
  }

  // Build a Contentful asset ID → theme ID map for event FK resolution

  // 1b. Sync organizations (check KV cache first)
  try {
    const cacheKey = `${CONTENTFUL_CACHE_PREFIX}:organizations`
    let orgEntries: ContentfulEntry[]
    if (kv) {
      const cached = await kv.get<ContentfulEntry[]>(cacheKey, 'json')
      if (cached) {
        orgEntries = cached
      } else {
        orgEntries = await contentful.getEntries(mergedConfig.organizationTypeId)
        await kv.put(cacheKey, JSON.stringify(orgEntries), { expirationTtl: CONTENTFUL_CACHE_TTL })
      }
    } else {
      orgEntries = await contentful.getEntries(mergedConfig.organizationTypeId)
    }
    await syncOrganizations(db, orgEntries, mergedConfig)
  } catch (err) {
    result.errors.push(`Organizations sync failed: ${err}`)
  }

  // 2. Sync events (check KV cache first)
  try {
    const cacheKey = `${CONTENTFUL_CACHE_PREFIX}:events`
    let eventEntries: ContentfulEntry[]
    if (kv) {
      const cached = await kv.get<ContentfulEntry[]>(cacheKey, 'json')
      if (cached) {
        eventEntries = cached
      } else {
        eventEntries = await contentful.getEntries(mergedConfig.eventTypeId)
        await kv.put(cacheKey, JSON.stringify(eventEntries), { expirationTtl: CONTENTFUL_CACHE_TTL })
      }
    } else {
      eventEntries = await contentful.getEntries(mergedConfig.eventTypeId)
    }
    result.eventsSynced = await syncEvents(db, bucket, contentful, allAssets, eventEntries, mergedConfig, result)
  } catch (err) {
    result.errors.push(`Events sync failed: ${err}`)
  }

  // 3. Sync FAQs (check KV cache first)
  try {
    const cacheKey = `${CONTENTFUL_CACHE_PREFIX}:faqs`
    let faqEntries: ContentfulEntry[]
    if (kv) {
      const cached = await kv.get<ContentfulEntry[]>(cacheKey, 'json')
      if (cached) {
        faqEntries = cached
      } else {
        faqEntries = await contentful.getEntries(mergedConfig.faqTypeId)
        await kv.put(cacheKey, JSON.stringify(faqEntries), { expirationTtl: CONTENTFUL_CACHE_TTL })
      }
    } else {
      faqEntries = await contentful.getEntries(mergedConfig.faqTypeId)
    }
    result.faqsSynced = await syncFaqs(db, faqEntries, mergedConfig)
  } catch (err) {
    result.errors.push(`FAQs sync failed: ${err}`)
  }

  console.log(
    `[Snapshot] Complete: ${result.themesSynced} themes, ${result.organizationsSynced} organizations, ${result.eventsSynced} events, ${result.faqsSynced} FAQs, ` +
    `${result.imagesUploaded} images uploaded, ${result.imagesSkipped} images skipped, ${result.errors.length} errors`,
  )

  return result
}

// ─── Theme sync ──────────────────────────────────────────────────────────────

async function syncThemes(
  db: LeapifyDb,
  entries: ContentfulEntry[],
  config: SnapshotConfig,
): Promise<number> {
  let count = 0

  for (const entry of entries) {
    const cfId = entry.sys.id
    const name = ContentfulService.getField<string>(entry, config.fields.theme.name)
    const path = ContentfulService.getField<string>(entry, config.fields.theme.path)

    if (!name || !path) continue

    await db
      .insert(themes)
      .values({ id: cfId, name, path })
      .onConflictDoUpdate({
        target: themes.id,
        set: { name, path },
      })

    count++
  }

  return count
}

// ─── Organization sync ──────────────────────────────────────────────────────

async function syncOrganizations(
  db: LeapifyDb,
  entries: ContentfulEntry[],
  config: SnapshotConfig,
): Promise<number> {
  let count = 0

  for (const entry of entries) {
    const cfId = entry.sys.id
    const f = config.fields.organization

    const name = ContentfulService.getField<string>(entry, f.name)
    const acronym = ContentfulService.getField<string>(entry, f.acronym)
    if (!name || !acronym) continue

    const logoUrl = ContentfulService.getField<string>(entry, f.logoUrl) ?? null
    const link = ContentfulService.getField<string>(entry, f.link) ?? null

    await db
      .insert(organizations)
      .values({ id: cfId, name, acronym, logoUrl, link })
      .onConflictDoUpdate({
        target: organizations.id,
        set: { name, acronym, logoUrl, link },
      })

    count++
  }

  return count
}

// ─── Event sync ──────────────────────────────────────────────────────────────

async function syncEvents(
  db: LeapifyDb,
  bucket: R2Bucket | undefined,
  contentful: ContentfulService,
  allAssets: ContentfulAsset[],
  entries: ContentfulEntry[],
  config: SnapshotConfig,
  result: SnapshotResult,
): Promise<number> {
  let count = 0

  for (const entry of entries) {
    try {
      const cfId = entry.sys.id
      const f = config.fields.event

      const title = ContentfulService.getField<string>(entry, f.title)
      if (!title) {
        result.errors.push(`Event ${cfId}: missing title, skipping`)
        continue
      }

      const slug =
        ContentfulService.getField<string>(entry, f.slug) ??
        slugify(title)

      // Resolve theme FK — the theme field is a Contentful reference
      // whose sys.id matches a theme entry's sys.id (used as D1 PK)
      const themeRef = ContentfulService.getField<{ sys: { id: string } }>(entry, f.theme)
      const themeId = themeRef?.sys?.id ?? null

      // Resolve organization FK
      const orgRef = ContentfulService.getField<{ sys: { id: string } }>(entry, f.organization)
      const organizationId = orgRef?.sys?.id ?? null

      // Handle image asset: download from Contentful CDN, SHA-dedup, upload to R2
      let backgroundImageUrl: string | null = null
      if (bucket) {
        const imageRef = ContentfulService.getField<{ sys: { id: string } }>(entry, f.image)
        const assetId = imageRef?.sys?.id

        if (assetId) {
          const assetUrl = ContentfulService.resolveAssetUrl(allAssets, assetId)
          if (assetUrl) {
            const r2Key = `contentful/${assetId}`
            const uploaded = await uploadAssetIfChanged(bucket, contentful, assetUrl, r2Key)
            if (uploaded.skipped) {
              result.imagesSkipped++
            } else {
              result.imagesUploaded++
            }
            backgroundImageUrl = `/uploads/images/${r2Key}`
          }
        }
      }

      // Build upsert values — only include non-undefined fields so we don't
      // overwrite existing D1 values with nulls for fields not in Contentful.
      const values: Record<string, unknown> = {
        id: cfId,
        contentfulEntryId: cfId,
        title,
        slug,
        themeId,
        organizationId,
        updatedAt: entry.sys.updatedAt,
      }

      const venue = ContentfulService.getField<string>(entry, f.venue)
      if (venue !== undefined) values.venue = venue

      const date = ContentfulService.getField<string>(entry, f.date)
      if (date !== undefined) values.dateTime = date

      const price = ContentfulService.getField<string>(entry, f.price)
      if (price !== undefined) values.price = price

      if (backgroundImageUrl) values.backgroundImageUrl = backgroundImageUrl

      const isSpotlight = ContentfulService.getField<boolean>(entry, f.isSpotlight)
      if (isSpotlight !== undefined) values.isSpotlight = isSpotlight

      const maxSlots = ContentfulService.getField<number>(entry, f.maxSlots)
      if (maxSlots !== undefined) values.maxSlots = maxSlots

      const gformsUrl = ContentfulService.getField<string>(entry, f.gformsUrl)
      if (gformsUrl !== undefined) values.gformsUrl = gformsUrl

      const gformsEditorUrl = ContentfulService.getField<string>(entry, f.gformsEditorUrl)
      if (gformsEditorUrl !== undefined) values.gformsEditorUrl = gformsEditorUrl

      const classCode = ContentfulService.getField<string>(entry, f.classCode)
      if (classCode !== undefined) values.classCode = classCode

      const startTime = ContentfulService.getField<string>(entry, f.startTime)
      if (startTime !== undefined) values.startTime = startTime

      const endTime = ContentfulService.getField<string>(entry, f.endTime)
      if (endTime !== undefined) values.endTime = endTime

      const regCloseRaw = ContentfulService.getField<string>(entry, f.registrationClosesAt)
      if (regCloseRaw) {
        const ms = Date.parse(regCloseRaw)
        if (!Number.isNaN(ms)) values.registrationClosesAt = Math.floor(ms / 1000)
      }

      await db
        .insert(events)
        .values(values as typeof events.$inferInsert)
        .onConflictDoUpdate({
          target: events.id,
          set: values as any,
        })

      count++
    } catch (err) {
      result.errors.push(`Event ${entry.sys.id}: ${err}`)
    }
  }

  return count
}

// ─── FAQ sync ────────────────────────────────────────────────────────────────

async function syncFaqs(
  db: LeapifyDb,
  entries: ContentfulEntry[],
  config: SnapshotConfig,
): Promise<number> {
  let count = 0

  for (const entry of entries) {
    const cfId = entry.sys.id
    const f = config.fields.faq

    const question = ContentfulService.getField<string>(entry, f.question)
    const answer = ContentfulService.getField<string>(entry, f.answer)
    if (!question || !answer) continue

    const category = ContentfulService.getField<string>(entry, f.category) ?? null
    const sortOrder = ContentfulService.getField<number>(entry, f.sortOrder) ?? 0

    await db
      .insert(faqs)
      .values({
        id: cfId,
        question,
        answer,
        category,
        sortOrder,
      })
      .onConflictDoUpdate({
        target: faqs.id,
        set: { question, answer, category, sortOrder },
      })

    count++
  }

  return count
}

// ─── R2 image upload with SHA dedup ──────────────────────────────────────────

/**
 * Downloads an asset from Contentful, computes its SHA-256, and uploads it
 * to R2 only if the SHA differs from the existing object's metadata.
 *
 * Returns `{ skipped: true }` if the object already exists with the same SHA.
 */
async function uploadAssetIfChanged(
  bucket: R2Bucket,
  contentful: ContentfulService,
  assetUrl: string,
  r2Key: string,
): Promise<{ skipped: boolean }> {
  // Download from Contentful CDN
  const { data, contentType } = await contentful.downloadAsset(assetUrl)

  // Compute SHA-256 of the downloaded file
  const sha = await computeSha256(data)

  // Check if R2 already has this object with the same SHA
  const existing = await bucket.head(r2Key)
  if (existing?.customMetadata?.sha256 === sha) {
    return { skipped: true }
  }

  // Upload to R2 with SHA in metadata
  await bucket.put(r2Key, data, {
    httpMetadata: { contentType },
    customMetadata: {
      sha256: sha,
      source: 'contentful',
      syncedAt: new Date().toISOString(),
    },
  })

  return { skipped: false }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run async tasks in batches with concurrency limit.
 * Returns settled results so partial failures don't abort the batch.
 */
async function batchRun<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency = 5,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const settled = await Promise.allSettled(batch.map(fn))
    results.push(...settled)
  }
  return results
}

async function computeSha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ─── Content type auto-generation ────────────────────────────────────────────

/**
 * Ensure all Leapify content types exist in Contentful.
 * Creates them if missing, updates if fields changed.
 *
 * Call this once on first sync or when the schema changes.
 */
export async function ensureContentTypes(
  mgmt: ContentfulManagement,
  config: Partial<SnapshotConfig> = {},
): Promise<void> {
  const eventTypeId = config.eventTypeId ?? 'event'
  const themeTypeId = config.themeTypeId ?? 'theme'
  const faqTypeId = config.faqTypeId ?? 'faq'
  const organizationTypeId = config.organizationTypeId ?? 'organization'

  // Theme content type
  await mgmt.ensureContentType(themeTypeId, 'Theme', [
    { id: 'name', name: 'Name', type: 'Symbol', required: true },
    { id: 'path', name: 'Path', type: 'Symbol', required: true },
  ])

  // Event content type
  await mgmt.ensureContentType(eventTypeId, 'Event', [
    { id: 'title', name: 'Title', type: 'Symbol', required: true },
    { id: 'slug', name: 'Slug', type: 'Symbol', required: true },
    { id: 'theme', name: 'Theme', type: 'Link', linkType: 'Entry' },
    { id: 'organization', name: 'Organization', type: 'Link', linkType: 'Entry' },
    { id: 'venue', name: 'Venue', type: 'Symbol' },
    { id: 'date', name: 'Date', type: 'Date' },
    { id: 'startTime', name: 'Start Time', type: 'Symbol' },
    { id: 'endTime', name: 'End Time', type: 'Symbol' },
    { id: 'price', name: 'Price', type: 'Symbol' },
    { id: 'image', name: 'Image', type: 'Link', linkType: 'Asset' },
    { id: 'isSpotlight', name: 'Spotlight', type: 'Boolean' },
    { id: 'maxSlots', name: 'Max Slots', type: 'Integer' },
    { id: 'gformsUrl', name: 'Google Forms URL', type: 'Symbol' },
    { id: 'gformsEditorUrl', name: 'Google Forms Editor URL', type: 'Symbol' },
    { id: 'registrationClosesAt', name: 'Registration Closes', type: 'Date' },
    { id: 'classCode', name: 'Class Code', type: 'Symbol' },
  ])

  // Organization content type
  await mgmt.ensureContentType(organizationTypeId, 'Organization', [
    { id: 'name', name: 'Name', type: 'Symbol', required: true },
    { id: 'acronym', name: 'Acronym', type: 'Symbol', required: true },
    { id: 'logo', name: 'Logo', type: 'Link', linkType: 'Asset' },
    { id: 'link', name: 'Link', type: 'Symbol' },
  ])

  // FAQ content type
  await mgmt.ensureContentType(faqTypeId, 'FAQ', [
    { id: 'question', name: 'Question', type: 'Symbol', required: true },
    { id: 'answer', name: 'Answer', type: 'Text', required: true },
    { id: 'category', name: 'Category', type: 'Symbol' },
    { id: 'sortOrder', name: 'Sort Order', type: 'Integer' },
  ])
}

// ─── D1 → Contentful push ───────────────────────────────────────────────────

const LAST_PUSH_KV_KEY = 'contentful:last_push'

/**
 * Push D1 content to Contentful, skipping entities that haven't changed
 * since the last successful push.
 *
 * Uses KV to store the last push timestamp. If `forceFull` is true,
 * pushes all entities regardless of changes.
 */
export async function pushToContentful(
  db: LeapifyDb,
  mgmt: ContentfulManagement,
  config: Partial<SnapshotConfig> = {},
  kv?: KVNamespace,
  forceFull = false,
): Promise<SnapshotResult> {
  const eventTypeId = config.eventTypeId ?? 'event'
  const themeTypeId = config.themeTypeId ?? 'theme'
  const faqTypeId = config.faqTypeId ?? 'faq'
  const organizationTypeId = config.organizationTypeId ?? 'organization'

  const result: SnapshotResult = {
    themesSynced: 0,
    eventsSynced: 0,
    faqsSynced: 0,
    organizationsSynced: 0,
    imagesUploaded: 0,
    imagesSkipped: 0,
    errors: [],
  }

  // Get last push timestamp from KV
  let lastPushTs = 0
  if (kv && !forceFull) {
    const stored = await kv.get(LAST_PUSH_KV_KEY)
    if (stored) lastPushTs = Number(stored) || 0
  }

  // 1. Push themes (small set — always push all)
  try {
    const dbThemes = await db.query.themes.findMany()
    for (const theme of dbThemes) {
      try {
        await mgmt.upsertEntry(themeTypeId, theme.id, {
          name: ContentfulManagement.locale(theme.name),
          path: ContentfulManagement.locale(theme.path),
        })
        result.themesSynced++
      } catch (err) {
        result.errors.push(`Theme ${theme.id}: ${err}`)
      }
    }
  } catch (err) {
    result.errors.push(`Themes fetch failed: ${err}`)
  }

  // 2. Push organizations (small set — always push all)
  try {
    const dbOrgs = await db.query.organizations.findMany()
    for (const org of dbOrgs) {
      try {
        const fields: Record<string, Record<string, unknown>> = {
          name: ContentfulManagement.locale(org.name),
          acronym: ContentfulManagement.locale(org.acronym),
          link: ContentfulManagement.locale(org.link),
        }
        // Logo is a Link (Asset) in Contentful — requires image upload via R2
        // Skip during bulk push; logo must be set via the admin UI upload flow
        await mgmt.upsertEntry(organizationTypeId, org.id, fields)
        result.organizationsSynced++
      } catch (err) {
        result.errors.push(`Organization ${org.id}: ${err}`)
      }
    }
  } catch (err) {
    result.errors.push(`Organizations fetch failed: ${err}`)
  }

  // 3. Push events (only changed since last push, concurrent batches)
  try {
    const dbEvents = lastPushTs > 0
      ? await db.query.events.findMany()
        .then((all) => all.filter((e) => {
          if (e.createdAt >= lastPushTs) return true
          if (e.publishedAt && e.publishedAt >= lastPushTs) return true
          if (!e.contentfulEntryId) return true
          return false
        }))
      : await db.query.events.findMany()

    await batchRun(dbEvents, async (event) => {
      const fields: Record<string, Record<string, unknown>> = {
        title: ContentfulManagement.locale(event.title),
        slug: ContentfulManagement.locale(event.slug),
        isSpotlight: ContentfulManagement.locale(event.isSpotlight),
        maxSlots: ContentfulManagement.locale(event.maxSlots),
      }

      if (event.themeId) fields.theme = ContentfulManagement.entryRef(event.themeId)
      if (event.organizationId) fields.organization = ContentfulManagement.entryRef(event.organizationId)
      if (event.venue) fields.venue = ContentfulManagement.locale(event.venue)
      if (event.dateTime) {
        // Convert human-readable date to ISO 8601 for Contentful Date field
        const parsed = new Date(event.dateTime)
        fields.date = ContentfulManagement.locale(
          Number.isNaN(parsed.getTime()) ? event.dateTime : parsed.toISOString(),
        )
      }
      if (event.price) fields.price = ContentfulManagement.locale(event.price)
      if (event.classCode) fields.classCode = ContentfulManagement.locale(event.classCode)
      if (event.startTime) fields.startTime = ContentfulManagement.locale(event.startTime)
      if (event.endTime) fields.endTime = ContentfulManagement.locale(event.endTime)
      if (event.gformsUrl) fields.gformsUrl = ContentfulManagement.locale(event.gformsUrl)
      if (event.gformsEditorUrl) fields.gformsEditorUrl = ContentfulManagement.locale(event.gformsEditorUrl)
      if (event.registrationClosesAt) fields.registrationClosesAt = ContentfulManagement.locale(new Date(event.registrationClosesAt * 1000).toISOString())

      await mgmt.upsertEntry(eventTypeId, event.id, fields)

      // Store Contentful entry ID if not yet set
      if (!event.contentfulEntryId) {
        await db
          .update(events)
          .set({ contentfulEntryId: event.id })
          .where(eq(events.id, event.id))
      }

      result.eventsSynced++
    })
  } catch (err) {
    result.errors.push(`Events fetch failed: ${err}`)
  }

  // 3. Push FAQs (only changed since last push, concurrent batches)
  try {
    const dbFaqs = lastPushTs > 0
      ? await db.query.faqs.findMany()
        .then((all) => all.filter((faq) => {
          if (faq.updatedAt >= lastPushTs) return true
          if (faq.createdAt >= lastPushTs) return true
          return false
        }))
      : await db.query.faqs.findMany()

    await batchRun(dbFaqs, async (faq) => {
      await mgmt.upsertEntry(faqTypeId, faq.id, {
        question: ContentfulManagement.locale(faq.question),
        answer: ContentfulManagement.locale(faq.answer),
        category: ContentfulManagement.locale(faq.category),
        sortOrder: ContentfulManagement.locale(faq.sortOrder),
      })
      result.faqsSynced++
    })
  } catch (err) {
    result.errors.push(`FAQs fetch failed: ${err}`)
  }

  // Store new last push timestamp in KV
  if (kv) {
    const now = Math.floor(Date.now() / 1000)
    await kv.put(LAST_PUSH_KV_KEY, String(now))
  }

  console.log(
    `[Push] Complete: ${result.themesSynced} themes, ${result.organizationsSynced} organizations, ${result.eventsSynced} events, ${result.faqsSynced} FAQs pushed to Contentful, ${result.errors.length} errors`,
  )

  return result
}
