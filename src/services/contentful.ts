/**
 * Contentful Delivery API client.
 * Fully fetch-native — no SDK (edge compatible).
 *
 * Uses the Content Delivery API (read-only, published content only).
 * All responses are JSON; asset files are fetched separately via their CDN URL.
 */

const CONTENTFUL_CDN = 'https://cdn.contentful.com'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContentfulSys {
  id: string
  type: string
  createdAt: string
  updatedAt: string
  contentType?: { sys: { type: string; linkType: string; id: string } }
}

interface ContentfulAssetFile {
  url: string
  details: { size: number; image?: { width: number; height: number } }
  fileName: string
  contentType: string
}

export interface ContentfulEntry {
  sys: ContentfulSys
  fields: Record<string, unknown>
}

export interface ContentfulAsset {
  sys: { id: string; type: 'Asset'; createdAt: string; updatedAt: string }
  fields: {
    title?: string
    description?: string
    file?: ContentfulAssetFile
  }
}

interface ContentfulResponse {
  sys: { type: 'Array' }
  total: number
  skip: number
  limit: number
  items: ContentfulEntry[]
  includes?: {
    Asset?: ContentfulAsset[]
    Entry?: ContentfulEntry[]
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ContentfulService {
  private readonly spaceId: string
  private readonly accessToken: string
  private readonly environment: string

  constructor(spaceId: string, accessToken: string, environment = 'master') {
    this.spaceId = spaceId
    this.accessToken = accessToken
    this.environment = environment
  }

  /**
   * Returns true if the required Contentful credentials are configured.
   */
  static isConfigured(
    spaceId?: string,
    accessToken?: string,
  ): boolean {
    return !!(spaceId && accessToken)
  }

  // ─── Entries ─────────────────────────────────────────────────────────────

  /**
   * Fetch all entries of a given content type.
   * Handles pagination automatically (100 per page, Contentful max).
   */
  async getEntries(contentTypeId: string): Promise<ContentfulEntry[]> {
    const allItems: ContentfulEntry[] = []
    let skip = 0
    const limit = 100

    do {
      const url = this.buildUrl(`/entries`, {
        content_type: contentTypeId,
        skip: String(skip),
        limit: String(limit),
        include: '2', // resolve up to 2 levels of linked entries/assets
      })

      const res = await fetch(url, { headers: this.headers() })
      if (!res.ok) {
        throw new Error(`Contentful entries error: ${res.status} ${await res.text()}`)
      }

      const data = (await res.json()) as ContentfulResponse
      allItems.push(...data.items)
      skip += limit

      if (allItems.length >= data.total) break
    } while (true)

    return allItems
  }

  /**
   * Fetch all assets. Handles pagination.
   */
  async getAssets(): Promise<ContentfulAsset[]> {
    const allItems: ContentfulAsset[] = []
    let skip = 0
    const limit = 100

    do {
      const url = this.buildUrl(`/assets`, {
        skip: String(skip),
        limit: String(limit),
      })

      const res = await fetch(url, { headers: this.headers() })
      if (!res.ok) {
        throw new Error(`Contentful assets error: ${res.status} ${await res.text()}`)
      }

      const data = (await res.json()) as {
        total: number
        items: ContentfulAsset[]
      }
      allItems.push(...data.items)
      skip += limit

      if (allItems.length >= data.total) break
    } while (true)

    return allItems
  }

  // ─── Asset file download ─────────────────────────────────────────────────

  /**
   * Download an asset file from Contentful's CDN.
   * Returns the raw ArrayBuffer and content type.
   */
  async downloadAsset(assetUrl: string): Promise<{ data: ArrayBuffer; contentType: string }> {
    // Contentful URLs are protocol-relative (//images.ctfassets.net/...)
    const url = assetUrl.startsWith('//') ? `https:${assetUrl}` : assetUrl

    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to download asset: ${res.status}`)
    }

    const contentType = res.headers.get('Content-Type') ?? 'application/octet-stream'
    const data = await res.arrayBuffer()

    return { data, contentType }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Extract a field value from a Contentful entry, handling locale wrapping.
   * Contentful fields are often `{ "en-US": value }` — this unwraps them.
   */
  static getField<T = unknown>(entry: ContentfulEntry, fieldName: string): T | undefined {
    const raw = entry.fields[fieldName]
    if (raw === undefined || raw === null) return undefined

    // Locale-wrapped: { "en-US": value }
    if (typeof raw === 'object' && !Array.isArray(raw) && 'en-US' in (raw as Record<string, unknown>)) {
      return (raw as Record<string, T>)['en-US']
    }

    return raw as T
  }

  /**
   * Extract a linked entry/sys reference ID from a reference field.
   */
  static getRefId(entry: ContentfulEntry, fieldName: string): string | undefined {
    const ref = ContentfulService.getField<{ sys: { id: string } }>(entry, fieldName)
    return ref?.sys?.id
  }

  /**
   * Extract an asset URL from a linked asset field.
   */
  static getAssetUrl(entry: ContentfulEntry, fieldName: string): string | undefined {
    const asset = ContentfulService.getField<{ sys: { id: string } }>(entry, fieldName)
    return asset?.sys?.id // we resolve the actual URL from includes/assets
  }

  /**
   * Resolve an asset URL by ID from a list of fetched assets.
   */
  static resolveAssetUrl(assets: ContentfulAsset[], assetId: string): string | undefined {
    const asset = assets.find((a) => a.sys.id === assetId)
    return asset?.fields?.file?.url
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    }
  }

  private buildUrl(
    path: string,
    params: Record<string, string> = {},
  ): string {
    const url = new URL(
      `/spaces/${this.spaceId}/environments/${this.environment}${path}`,
      CONTENTFUL_CDN,
    )
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    return url.toString()
  }
}
