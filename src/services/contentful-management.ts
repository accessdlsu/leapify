/**
 * Contentful Content Management API client.
 * Used to create/update content types, entries, and assets.
 * Fully fetch-native — no SDK (edge compatible).
 *
 * Requires a Content Management Token (not the Delivery API token).
 */

const CONTENTFUL_MGMT = 'https://api.contentful.com'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContentTypeField {
  id: string
  name: string
  type: 'Symbol' | 'Text' | 'Integer' | 'Number' | 'Boolean' | 'Date' | 'Object' | 'Link' | 'Array'
  required?: boolean
  localized?: boolean
  validations?: unknown[]
  items?: { type: string; validations?: unknown[] }
  linkType?: 'Entry' | 'Asset'
}

interface ContentType {
  sys: { id: string; type: string; version?: number; publishedVersion?: number }
  name: string
  fields: ContentTypeField[]
}

interface ContentfulEntry {
  sys: { id: string; type: string; contentType: { sys: { id: string } }; version?: number; publishedVersion?: number }
  fields: Record<string, Record<string, unknown>>
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ContentfulManagement {
  private readonly spaceId: string
  private readonly token: string
  private readonly environment: string

  constructor(spaceId: string, token: string, environment = 'master') {
    this.spaceId = spaceId
    this.token = token
    this.environment = environment
  }

  static isConfigured(spaceId?: string, token?: string): boolean {
    return !!(spaceId && token)
  }

  // ─── Content Types ───────────────────────────────────────────────────────

  /**
   * Get a content type by ID. Returns null if not found.
   */
  async getContentType(contentTypeId: string): Promise<ContentType | null> {
    const res = await this.fetch(`/content_types/${contentTypeId}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Failed to get content type: ${res.status} ${await res.text()}`)
    return res.json() as Promise<ContentType>
  }

  /**
   * Create a content type. Does NOT publish it — call publishContentType() after.
   */
  async createContentType(contentTypeId: string, name: string, fields: ContentTypeField[]): Promise<ContentType> {
    const res = await this.fetch(`/content_types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader() },
      body: JSON.stringify({
        sys: { id: contentTypeId, type: 'ContentType' },
        name,
        fields,
      }),
    })
    if (!res.ok) throw new Error(`Failed to create content type: ${res.status} ${await res.text()}`)
    const ct = (await res.json()) as ContentType
    console.log(`[Contentful] Created content type ${contentTypeId}: version=${ct.sys.version}`)
    return ct
  }

  /**
   * Update a content type. Must republish after update.
   */
  async updateContentType(contentTypeId: string, name: string, fields: ContentTypeField[], version: number): Promise<ContentType> {
    const res = await this.fetch(`/content_types/${contentTypeId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeader(),
        'X-Contentful-Version': String(version),
      },
      body: JSON.stringify({
        sys: { id: contentTypeId, type: 'ContentType' },
        name,
        fields,
      }),
    })
    if (!res.ok) throw new Error(`Failed to update content type: ${res.status} ${await res.text()}`)
    return res.json() as Promise<ContentType>
  }

  /**
   * Publish a content type (makes it available for entries).
   */
  async publishContentType(contentTypeId: string, version: number): Promise<ContentType> {
    console.log(`[Contentful] Publishing content type ${contentTypeId} with version ${version}`)

    const res = await this.fetch(`/content_types/${contentTypeId}/published`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/vnd.contentful.management.v1+json',
        ...this.authHeader(),
        'X-Contentful-Version': String(version),
      },
    })
    if (!res.ok) {
      const body = await res.text()
      console.error(`[Contentful] Publish failed: ${res.status} ${body}`)
      throw new Error(`Failed to publish content type: ${res.status} ${body}`)
    }
    return res.json() as Promise<ContentType>
  }

  // ─── Entries ─────────────────────────────────────────────────────────────

  /**
   * Get an entry by ID. Returns null if not found.
   */
  async getEntry(entryId: string): Promise<ContentfulEntry | null> {
    const res = await this.fetch(`/entries/${entryId}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Failed to get entry: ${res.status} ${await res.text()}`)
    return res.json() as Promise<ContentfulEntry>
  }

  /**
   * Create a new entry. Does NOT publish — call publishEntry() after.
   * Fields must be locale-wrapped: { "en-US": value }
   */
  async createEntry(contentTypeId: string, entryId: string, fields: Record<string, Record<string, unknown>>): Promise<ContentfulEntry> {
    const res = await this.fetch(`/entries?content_type=${contentTypeId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/vnd.contentful.management.v1+json',
        ...this.authHeader(),
        'X-Contentful-Content-Type': contentTypeId,
      },
      body: JSON.stringify({
        sys: { id: entryId, type: 'Entry' },
        fields,
      }),
    })
    if (!res.ok) throw new Error(`Failed to create entry: ${res.status} ${await res.text()}`)
    return res.json() as Promise<ContentfulEntry>
  }

  /**
   * Update an existing entry. Must republish after update.
   */
  async updateEntry(entryId: string, fields: Record<string, Record<string, unknown>>, version: number): Promise<ContentfulEntry> {
    const res = await this.fetch(`/entries/${entryId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/vnd.contentful.management.v1+json',
        ...this.authHeader(),
        'X-Contentful-Version': String(version),
      },
      body: JSON.stringify({ fields }),
    })
    if (!res.ok) throw new Error(`Failed to update entry: ${res.status} ${await res.text()}`)
    return res.json() as Promise<ContentfulEntry>
  }

  /**
   * Publish an entry (makes it available via Delivery API).
   */
  async publishEntry(entryId: string, version: number): Promise<ContentfulEntry> {
    const res = await this.fetch(`/entries/${entryId}/published`, {
      method: 'PUT',
      headers: {
        ...this.authHeader(),
        'X-Contentful-Version': String(version),
      },
    })
    if (!res.ok) throw new Error(`Failed to publish entry: ${res.status} ${await res.text()}`)
    return res.json() as Promise<ContentfulEntry>
  }

  /**
   * Upsert an entry: create if missing, update if exists, then publish.
   */
  async upsertEntry(
    contentTypeId: string,
    entryId: string,
    fields: Record<string, Record<string, unknown>>,
  ): Promise<ContentfulEntry> {
    // Try to get existing entry; if fetch hangs or fails, skip to create
    let existing: ContentfulEntry | null = null
    try {
      existing = await Promise.race([
        this.getEntry(entryId),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('getEntry timeout')), 5000)),
      ])
    } catch (err) {
      console.warn(`[Contentful] getEntry failed (will try create): ${err}`)
    }
    console.log(`[Contentful] upsertEntry: existing=${existing ? 'yes' : 'no'}`)

    let entry: ContentfulEntry
    if (existing) {
      entry = await this.updateEntry(entryId, fields, existing.sys.version ?? 1)
    } else {
      console.log(`[Contentful] upsertEntry: creating new entry...`)
      entry = await this.createEntry(contentTypeId, entryId, fields)
    }
    console.log(`[Contentful] upsertEntry: publishing (version=${entry.sys.version})`)

    const published = await this.publishEntry(entry.sys.id, entry.sys.version ?? 1)
    console.log(`[Contentful] upsertEntry: published successfully`)
    return published
  }

  // ─── Content type setup ──────────────────────────────────────────────────

  /**
   * Ensure a content type exists and is published with the given fields.
   * Creates it if missing, updates if fields changed.
   */
  async ensureContentType(
    contentTypeId: string,
    name: string,
    fields: ContentTypeField[],
  ): Promise<void> {
    const existing = await this.getContentType(contentTypeId)

    if (!existing) {
      const created = await this.createContentType(contentTypeId, name, fields)
      const version = created.sys.version ?? 1
      console.log(`[Contentful] Created content type ${contentTypeId}, attempting publish with version ${version}`)
      try {
        await this.publishContentType(contentTypeId, version)
        console.log(`[Contentful] Created and published content type: ${contentTypeId}`)
      } catch (err) {
        console.warn(`[Contentful] Created content type ${contentTypeId} but publish failed (entries will still work): ${err}`)
      }
      return
    }

    // Check if fields changed (simple comparison of field IDs)
    const existingFieldIds = existing.fields.map((f) => f.id).sort().join(',')
    const newFieldIds = fields.map((f) => f.id).sort().join(',')

    if (existingFieldIds !== newFieldIds) {
      const updated = await this.updateContentType(contentTypeId, name, fields, existing.sys.version ?? 1)
      // Fetch again to get the correct version for publishing
      const fetched = await this.getContentType(contentTypeId)
      const version = fetched?.sys.version ?? updated.sys.version ?? 1
      try {
        await this.publishContentType(contentTypeId, version)
        console.log(`[Contentful] Updated and published content type: ${contentTypeId}`)
      } catch (err) {
        console.warn(`[Contentful] Updated content type ${contentTypeId} but publish failed: ${err}`)
      }
    } else if (!existing.sys.publishedVersion || existing.sys.publishedVersion < (existing.sys.version ?? 0)) {
      // Content type exists and fields match, but might not be published
      try {
        await this.publishContentType(contentTypeId, existing.sys.version ?? 1)
        console.log(`[Contentful] Published content type: ${contentTypeId}`)
      } catch (err) {
        console.warn(`[Contentful] Publish failed for ${contentTypeId}: ${err}`)
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Locale-wrap a value for Contentful fields.
   */
  static locale(value: unknown): Record<string, unknown> {
    return { 'en-US': value }
  }

  /**
   * Locale-wrap a reference (Link to Entry).
   */
  static entryRef(entryId: string): Record<string, unknown> {
    return { 'en-US': { sys: { type: 'Link', linkType: 'Entry', id: entryId } } }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` }
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${CONTENTFUL_MGMT}/spaces/${this.spaceId}/environments/${this.environment}${path}`
    return globalThis.fetch(url, {
      ...init,
      headers: { ...this.authHeader(), ...init?.headers },
    })
  }
}
