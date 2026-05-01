/**
 * Contentful → D1 + R2 snapshot service.
 *
 * Pulls published content from Contentful, downloads images into R2
 * (with SHA-256 dedup to skip unchanged files), and upserts rows into D1.
 *
 * Called by the `snapshot_content` queue handler and the admin sync endpoint.
 */

import type { R2Bucket } from '@cloudflare/workers-types'
import { ContentfulService, type ContentfulEntry, type ContentfulAsset } from './contentful'
import { ContentfulManagement } from './contentful-management'
import type { LeapifyDb } from '../db'
import { themes } from '../db/schema/themes'
import { events } from '../db/schema/events'
import { faqs } from '../db/schema/faqs'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SnapshotConfig {
  eventTypeId: string
  themeTypeId: string
  faqTypeId: string
  fields: {
    event: {
      title: string
      slug: string
      theme: string
      org: string
      venue: string
      dateTime: string
      startsAt: string
      endsAt: string
      price: string
      backgroundColor: string
      image: string
      subtheme: string
      isMajor: string
      maxSlots: string
      gformsUrl: string
      registrationOpensAt: string
      registrationClosesAt: string
    }
    theme: {
      name: string
      path: string
      color: string
    }
    faq: {
      question: string
      answer: string
      category: string
      sortOrder: string
      isActive: string
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
    org: 'org',
    venue: 'venue',
    dateTime: 'dateTime',
    startsAt: 'startsAt',
    endsAt: 'endsAt',
    price: 'price',
    backgroundColor: 'backgroundColor',
    image: 'image',
    subtheme: 'subtheme',
    isMajor: 'isMajor',
    maxSlots: 'maxSlots',
    gformsUrl: 'gformsUrl',
    registrationOpensAt: 'registrationOpensAt',
    registrationClosesAt: 'registrationClosesAt',
  },
  theme: {
    name: 'name',
    path: 'path',
    color: 'color',
  },
  faq: {
    question: 'question',
    answer: 'answer',
    category: 'category',
    sortOrder: 'sortOrder',
    isActive: 'isActive',
  },
  siteConfig: {
    key: 'key',
    value: 'value',
  },
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a full Contentful → D1 + R2 snapshot.
 *
 * 1. Fetches all themes, events, and FAQs from Contentful.
 * 2. For each image asset: downloads from Contentful CDN, computes SHA-256,
 *    checks R2 for an existing object with the same SHA, and skips the upload
 *    if unchanged (dedup).
 * 3. Upserts all entries into D1.
 */
export async function snapshotAllContent(
  db: LeapifyDb,
  bucket: R2Bucket | undefined,
  contentful: ContentfulService,
  config: Partial<SnapshotConfig> = {},
): Promise<SnapshotResult> {
  const mergedConfig: SnapshotConfig = {
    eventTypeId: config.eventTypeId ?? 'event',
    themeTypeId: config.themeTypeId ?? 'theme',
    faqTypeId: config.faqTypeId ?? 'faq',
    fields: {
      event: { ...DEFAULT_FIELDS.event, ...config.fields?.event },
      theme: { ...DEFAULT_FIELDS.theme, ...config.fields?.theme },
      faq: { ...DEFAULT_FIELDS.faq, ...config.fields?.faq },
      siteConfig: { ...DEFAULT_FIELDS.siteConfig, ...config.fields?.siteConfig },
    },
  }

  const result: SnapshotResult = {
    themesSynced: 0,
    eventsSynced: 0,
    faqsSynced: 0,
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

  // 1. Sync themes
  try {
    const themeEntries = await contentful.getEntries(mergedConfig.themeTypeId)
    result.themesSynced = await syncThemes(db, themeEntries, mergedConfig)
  } catch (err) {
    result.errors.push(`Themes sync failed: ${err}`)
  }

  // Build a Contentful asset ID → theme ID map for event FK resolution
  // (not needed for themes themselves, but useful if events reference themes by CF ID)

  // 2. Sync events
  try {
    const eventEntries = await contentful.getEntries(mergedConfig.eventTypeId)
    result.eventsSynced = await syncEvents(db, bucket, contentful, allAssets, eventEntries, mergedConfig, result)
  } catch (err) {
    result.errors.push(`Events sync failed: ${err}`)
  }

  // 3. Sync FAQs
  try {
    const faqEntries = await contentful.getEntries(mergedConfig.faqTypeId)
    result.faqsSynced = await syncFaqs(db, faqEntries, mergedConfig)
  } catch (err) {
    result.errors.push(`FAQs sync failed: ${err}`)
  }

  console.log(
    `[Snapshot] Complete: ${result.themesSynced} themes, ${result.eventsSynced} events, ${result.faqsSynced} FAQs, ` +
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
    const color = ContentfulService.getField<string>(entry, config.fields.theme.color) ?? null

    if (!name || !path) continue

    await db
      .insert(themes)
      .values({ id: cfId, name, path, color })
      .onConflictDoUpdate({
        target: themes.id,
        set: { name, path, color },
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
        updatedAt: entry.sys.updatedAt,
      }

      const org = ContentfulService.getField<string>(entry, f.org)
      if (org !== undefined) values.org = org

      const venue = ContentfulService.getField<string>(entry, f.venue)
      if (venue !== undefined) values.venue = venue

      const dateTime = ContentfulService.getField<string>(entry, f.dateTime)
      if (dateTime !== undefined) values.dateTime = dateTime

      const startsAt = parseDateField(entry, f.startsAt)
      if (startsAt !== undefined) values.startsAt = startsAt

      const endsAt = parseDateField(entry, f.endsAt)
      if (endsAt !== undefined) values.endsAt = endsAt

      const price = ContentfulService.getField<string>(entry, f.price)
      if (price !== undefined) values.price = price

      const backgroundColor = ContentfulService.getField<string>(entry, f.backgroundColor)
      if (backgroundColor !== undefined) values.backgroundColor = backgroundColor

      if (backgroundImageUrl) values.backgroundImageUrl = backgroundImageUrl

      const subtheme = ContentfulService.getField<string>(entry, f.subtheme)
      if (subtheme !== undefined) values.subtheme = subtheme

      const isMajor = ContentfulService.getField<boolean>(entry, f.isMajor)
      if (isMajor !== undefined) values.isMajor = isMajor

      const maxSlots = ContentfulService.getField<number>(entry, f.maxSlots)
      if (maxSlots !== undefined) values.maxSlots = maxSlots

      const gformsUrl = ContentfulService.getField<string>(entry, f.gformsUrl)
      if (gformsUrl !== undefined) values.gformsUrl = gformsUrl

      const registrationOpensAt = parseDateField(entry, f.registrationOpensAt)
      if (registrationOpensAt !== undefined) values.registrationOpensAt = registrationOpensAt

      const registrationClosesAt = parseDateField(entry, f.registrationClosesAt)
      if (registrationClosesAt !== undefined) values.registrationClosesAt = registrationClosesAt

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
    const isActive = ContentfulService.getField<boolean>(entry, f.isActive) ?? true

    await db
      .insert(faqs)
      .values({
        id: cfId,
        question,
        answer,
        category,
        sortOrder,
        isActive,
      })
      .onConflictDoUpdate({
        target: faqs.id,
        set: { question, answer, category, sortOrder, isActive },
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

/**
 * Parse a Contentful date field into a unix epoch (seconds).
 * Returns undefined if the field is missing or unparseable.
 */
function parseDateField(entry: ContentfulEntry, fieldName: string): number | undefined {
  const value = ContentfulService.getField<string>(entry, fieldName)
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
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

  // Theme content type
  await mgmt.ensureContentType(themeTypeId, 'Theme', [
    { id: 'name', name: 'Name', type: 'Symbol', required: true },
    { id: 'path', name: 'Path', type: 'Symbol', required: true },
    { id: 'color', name: 'Color', type: 'Symbol' },
  ])

  // Event content type
  await mgmt.ensureContentType(eventTypeId, 'Event', [
    { id: 'title', name: 'Title', type: 'Symbol', required: true },
    { id: 'slug', name: 'Slug', type: 'Symbol', required: true },
    { id: 'theme', name: 'Theme', type: 'Link', linkType: 'Entry' },
    { id: 'org', name: 'Organization', type: 'Symbol' },
    { id: 'venue', name: 'Venue', type: 'Symbol' },
    { id: 'dateTime', name: 'Date/Time', type: 'Symbol' },
    { id: 'startsAt', name: 'Starts At', type: 'Date' },
    { id: 'endsAt', name: 'Ends At', type: 'Date' },
    { id: 'price', name: 'Price', type: 'Symbol' },
    { id: 'backgroundColor', name: 'Background Color', type: 'Symbol' },
    { id: 'image', name: 'Image', type: 'Link', linkType: 'Asset' },
    { id: 'subtheme', name: 'Subtheme', type: 'Symbol' },
    { id: 'isMajor', name: 'Major Event', type: 'Boolean' },
    { id: 'maxSlots', name: 'Max Slots', type: 'Integer' },
    { id: 'gformsUrl', name: 'Google Forms URL', type: 'Symbol' },
    { id: 'registrationOpensAt', name: 'Registration Opens', type: 'Date' },
    { id: 'registrationClosesAt', name: 'Registration Closes', type: 'Date' },
  ])

  // FAQ content type
  await mgmt.ensureContentType(faqTypeId, 'FAQ', [
    { id: 'question', name: 'Question', type: 'Symbol', required: true },
    { id: 'answer', name: 'Answer', type: 'Text', required: true },
    { id: 'category', name: 'Category', type: 'Symbol' },
    { id: 'sortOrder', name: 'Sort Order', type: 'Integer' },
    { id: 'isActive', name: 'Active', type: 'Boolean' },
  ])
}

// ─── D1 → Contentful push ───────────────────────────────────────────────────

/**
 * Push all D1 content to Contentful.
 * Creates/updates entries in Contentful and publishes them.
 * Images are NOT uploaded to Contentful — they stay in R2.
 *
 * This is the primary sync direction: admin console writes to D1,
 * then this function pushes to Contentful for CMS features.
 */
export async function pushToContentful(
  db: LeapifyDb,
  mgmt: ContentfulManagement,
  config: Partial<SnapshotConfig> = {},
): Promise<SnapshotResult> {
  const eventTypeId = config.eventTypeId ?? 'event'
  const themeTypeId = config.themeTypeId ?? 'theme'
  const faqTypeId = config.faqTypeId ?? 'faq'

  const result: SnapshotResult = {
    themesSynced: 0,
    eventsSynced: 0,
    faqsSynced: 0,
    imagesUploaded: 0,
    imagesSkipped: 0,
    errors: [],
  }

  // 1. Push themes
  try {
    const dbThemes = await db.query.themes.findMany()
    for (const theme of dbThemes) {
      try {
        await mgmt.upsertEntry(themeTypeId, theme.id, {
          name: ContentfulManagement.locale(theme.name),
          path: ContentfulManagement.locale(theme.path),
          color: ContentfulManagement.locale(theme.color),
        })
        result.themesSynced++
      } catch (err) {
        result.errors.push(`Theme ${theme.id}: ${err}`)
      }
    }
  } catch (err) {
    result.errors.push(`Themes fetch failed: ${err}`)
  }

  // 2. Push events
  try {
    const dbEvents = await db.query.events.findMany()
    for (const event of dbEvents) {
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
        if (event.subtheme) fields.subtheme = ContentfulManagement.locale(event.subtheme)
        if (event.gformsUrl) fields.gformsUrl = ContentfulManagement.locale(event.gformsUrl)

        // Date fields — Contentful expects ISO strings
        if (event.startsAt) fields.startsAt = ContentfulManagement.locale(new Date(event.startsAt * 1000).toISOString())
        if (event.endsAt) fields.endsAt = ContentfulManagement.locale(new Date(event.endsAt * 1000).toISOString())
        if (event.registrationOpensAt) fields.registrationOpensAt = ContentfulManagement.locale(new Date(event.registrationOpensAt * 1000).toISOString())
        if (event.registrationClosesAt) fields.registrationClosesAt = ContentfulManagement.locale(new Date(event.registrationClosesAt * 1000).toISOString())

        await mgmt.upsertEntry(eventTypeId, event.id, fields)
        result.eventsSynced++
      } catch (err) {
        result.errors.push(`Event ${event.id}: ${err}`)
      }
    }
  } catch (err) {
    result.errors.push(`Events fetch failed: ${err}`)
  }

  // 3. Push FAQs
  try {
    const dbFaqs = await db.query.faqs.findMany()
    for (const faq of dbFaqs) {
      try {
        await mgmt.upsertEntry(faqTypeId, faq.id, {
          question: ContentfulManagement.locale(faq.question),
          answer: ContentfulManagement.locale(faq.answer),
          category: ContentfulManagement.locale(faq.category),
          sortOrder: ContentfulManagement.locale(faq.sortOrder),
          isActive: ContentfulManagement.locale(faq.isActive),
        })
        result.faqsSynced++
      } catch (err) {
        result.errors.push(`FAQ ${faq.id}: ${err}`)
      }
    }
  } catch (err) {
    result.errors.push(`FAQs fetch failed: ${err}`)
  }

  console.log(
    `[Push] Complete: ${result.themesSynced} themes, ${result.eventsSynced} events, ${result.faqsSynced} FAQs pushed to Contentful, ${result.errors.length} errors`,
  )

  return result
}
