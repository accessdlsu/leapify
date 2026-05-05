/**
 * Contentful Content Management API client.
 * Hand-rolled fetch-based — fully edge-compatible (CF Workers).
 *
 * Contentful content type lifecycle:
 *   POST /content_types        → Draft (version 1)
 *   PUT  /content_types/{id}   → Changed (version 2+)
 *   PUT  /content_types/{id}/published → Published
 *
 * After POST, there is eventual consistency. The content type may not
 * be immediately available for PUT/GET. We handle this with retries.
 */

const CONTENTFUL_MGMT = 'https://api.contentful.com'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContentTypeField {
  id: string
  name: string
  type: 'Symbol' | 'Text' | 'Integer' | 'Number' | 'Boolean' | 'Date' | 'Object' | 'Link' | 'Array'
  required?: boolean
  localized?: boolean
  validations?: unknown[]
  items?: { type: string; validations?: unknown[] }
  linkType?: 'Entry' | 'Asset'
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

  async getContentType(contentTypeId: string): Promise<any | null> {
    try {
      const res = await this.fetch(`/content_types/${contentTypeId}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`Failed to get content type: ${res.status}`)
      return res.json()
    } catch {
      return null
    }
  }

  async ensureContentType(
    contentTypeId: string,
    name: string,
    fields: ContentTypeField[],
  ): Promise<void> {
    const existing = await this.getContentType(contentTypeId)

    if (!existing) {
      console.log(`[Contentful] Creating content type ${contentTypeId}...`)
      const created = await this.createContentType(contentTypeId, name, fields)
      console.log(`[Contentful] Created ${contentTypeId} v${created.sys.version}`)

      // Wait for Contentful propagation: poll GET until the content type is findable
      // Only THEN can we save (PUT) without creating a duplicate
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((r) => setTimeout(r, 2000))
        const fetched = await this.getContentType(contentTypeId)
        if (fetched) {
          console.log(`[Contentful] Found ${contentTypeId} after ${(attempt + 1) * 2}s`)
          // Now save to transition Draft → Changed
          const saved = await this.saveContentType(contentTypeId, name, fields, fetched.sys.version!)
          console.log(`[Contentful] Saved ${contentTypeId} → v${saved.sys.version}`)
          // Now publish
          await this.publishContentType(contentTypeId, saved.sys.version!)
          console.log(`[Contentful] Published ${contentTypeId}`)
          return
        }
      }
      console.warn(`[Contentful] Could not find ${contentTypeId} after 30s`)
      return
    }

    // Already exists — try to publish if not yet published
    if (!existing.sys.publishedVersion || existing.sys.publishedVersion < (existing.sys.version ?? 0)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.publishContentType(contentTypeId, existing.sys.version ?? 1)
          console.log(`[Contentful] Published ${contentTypeId}`)
          return
        } catch {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        }
      }
    }

    // Check if fields or displayField changed
    const existingFieldIds = existing.fields.map((f: any) => f.id).sort().join(',')
    const newFieldIds = fields.map((f) => f.id).sort().join(',')
    if (existingFieldIds !== newFieldIds || !existing.displayField) {
      const updated = await this.saveContentType(contentTypeId, name, fields, existing.sys.version ?? 1)
      await this.publishContentType(contentTypeId, updated.sys.version!)
      console.log(`[Contentful] Updated + published ${contentTypeId}`)
    }
  }

  // ─── Entries ─────────────────────────────────────────────────────────────

  async getEntry(entryId: string): Promise<any | null> {
    try {
      const res = await this.fetch(`/entries/${entryId}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`Failed to get entry: ${res.status}`)
      return res.json()
    } catch {
      return null
    }
  }

  async upsertEntry(
    contentTypeId: string,
    entryId: string,
    fields: Record<string, Record<string, unknown>>,
  ): Promise<any> {
    const existing = await this.getEntry(entryId)

    let entry: any
    if (existing) {
      entry = await this.updateEntry(entryId, fields, existing.sys.version ?? 1)
    } else {
      entry = await this.createEntry(contentTypeId, entryId, fields)
    }

    return this.publishEntry(entry.sys.id, entry.sys.version ?? 1)
  }

  // ─── Asset Uploads ────────────────────────────────────────────────────────

  async uploadFile(_fileName: string, data: ArrayBuffer, contentType: string): Promise<string> {
    const res = await globalThis.fetch(
      `${CONTENTFUL_MGMT}/spaces/${this.spaceId}/environments/${this.environment}/uploads`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': contentType,
          'Content-Length': String(data.byteLength),
        },
        body: data,
      },
    )
    if (!res.ok) throw new Error(`Failed to upload file: ${res.status}`)
    const result = await res.json() as { sys: { id: string } }
    return result.sys.id
  }

  async createAssetFromUpload(
    uploadId: string,
    title: string,
    fileName: string,
    contentType: string,
  ): Promise<{ id: string; url: string }> {
    const createRes = await this.fetch('/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.contentful.management.v1+json' },
      body: JSON.stringify({
        fields: {
          title: { 'en-US': title },
          file: {
            'en-US': {
              contentType,
              fileName,
              uploadFrom: { sys: { type: 'Link', linkType: 'Upload', id: uploadId } },
            },
          },
        },
      }),
    })
    if (!createRes.ok) throw new Error(`Failed to create asset: ${createRes.status}`)
    const asset = await createRes.json() as { sys: { id: string; version: number } }

    const processRes = await this.fetch(`/assets/${asset.sys.id}/processed`, {
      method: 'PUT',
      headers: { 'X-Contentful-Version': String(asset.sys.version) },
    })
    if (!processRes.ok) throw new Error(`Failed to process asset: ${processRes.status}`)
    const processed = await processRes.json() as { sys: { id: string; version: number } }

    const published = await this.publishEntry(processed.sys.id, processed.sys.version)
    const url = (published.fields as any)?.file?.['en-US']?.url ?? ''
    return { id: published.sys.id, url }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  static locale(value: unknown): Record<string, unknown> {
    return { 'en-US': value }
  }

  static entryRef(entryId: string): Record<string, unknown> {
    return { 'en-US': { sys: { type: 'Link', linkType: 'Entry', id: entryId } } }
  }

  static assetRef(assetId: string): Record<string, unknown> {
    return { 'en-US': { sys: { type: 'Link', linkType: 'Asset', id: assetId } } }
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

  private async createContentType(contentTypeId: string, name: string, fields: ContentTypeField[]): Promise<any> {
    const res = await this.fetch('/content_types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sys: { id: contentTypeId, type: 'ContentType' },
        name,
        displayField: fields[0]?.id,
        fields,
      }),
    })
    if (res.status === 409) {
      const existing = await this.getContentType(contentTypeId)
      if (existing) return existing
    }
    if (!res.ok) throw new Error(`Failed to create content type: ${res.status}`)
    return res.json()
  }

  private async saveContentType(contentTypeId: string, name: string, fields: ContentTypeField[], version: number): Promise<any> {
    const res = await this.fetch(`/content_types/${contentTypeId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Contentful-Version': String(version),
      },
      body: JSON.stringify({
        sys: { id: contentTypeId, type: 'ContentType' },
        name,
        displayField: fields[0]?.id,
        fields,
      }),
    })
    if (!res.ok) throw new Error(`Failed to save content type: ${res.status}`)
    return res.json()
  }

  private async publishContentType(contentTypeId: string, version: number): Promise<any> {
    const url = `${CONTENTFUL_MGMT}/spaces/${this.spaceId}/environments/${this.environment}/content_types/${contentTypeId}/published`
    const res = await globalThis.fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Contentful-Version': String(version),
      },
    })
    if (!res.ok) throw new Error(`Failed to publish content type: ${res.status}`)
    return res.json()
  }

  private async createEntry(contentTypeId: string, entryId: string, fields: Record<string, Record<string, unknown>>): Promise<any> {
    const url = `${CONTENTFUL_MGMT}/spaces/${this.spaceId}/environments/${this.environment}/entries/${entryId}`
    const res = await globalThis.fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/vnd.contentful.management.v1+json',
        Authorization: `Bearer ${this.token}`,
        'X-Contentful-Content-Type': contentTypeId,
      },
      body: JSON.stringify({ fields }),
    })
    if (!res.ok) throw new Error(`Failed to create entry: ${res.status}`)
    return res.json()
  }

  private async updateEntry(entryId: string, fields: Record<string, Record<string, unknown>>, version: number): Promise<any> {
    const res = await this.fetch(`/entries/${entryId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/vnd.contentful.management.v1+json',
        'X-Contentful-Version': String(version),
      },
      body: JSON.stringify({ fields }),
    })
    if (!res.ok) throw new Error(`Failed to update entry: ${res.status}`)
    return res.json()
  }

  private async publishEntry(entryId: string, version: number): Promise<any> {
    const res = await this.fetch(`/entries/${entryId}/published`, {
      method: 'PUT',
      headers: { 'X-Contentful-Version': String(version) },
    })
    if (!res.ok) throw new Error(`Failed to publish entry: ${res.status}`)
    return res.json()
  }
}
