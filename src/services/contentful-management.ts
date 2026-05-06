/**
 * Contentful Content Management API client.
 * Uses the official `contentful-management` SDK with the plain client API.
 */

import { createClient } from 'contentful-management'

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
  private readonly client: any

  constructor(spaceId: string, token: string, environment = 'master') {
    this.client = createClient(
      { accessToken: token },
      {
        type: 'plain',
        defaults: { spaceId, environmentId: environment },
      },
    )
  }

  static isConfigured(spaceId?: string, token?: string): boolean {
    return !!(spaceId && token)
  }

  // ─── Content Types ───────────────────────────────────────────────────────

  async getContentType(contentTypeId: string): Promise<any | null> {
    try {
      return await this.client.contentType.get({ contentTypeId })
    } catch (err: any) {
      if (err?.status === 404) return null
      console.warn(`[Contentful] getContentType(${contentTypeId}) error:`, err?.message ?? err)
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
      try {
        const created = await this.client.contentType.createWithId(
          { contentTypeId },
          { name, fields, displayField: fields[0]?.id },
        )
        console.log(`[Contentful] Created ${contentTypeId} v${created.sys.version}`)

        // Wait for Contentful propagation then save + publish
        let version = created.sys.version!
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise((r) => setTimeout(r, 3000))
          try {
            const saved = await this.client.contentType.update(
              { contentTypeId },
              { ...created, name, fields, displayField: fields[0]?.id, sys: { ...created.sys, version } },
            )
            console.log(`[Contentful] Saved ${contentTypeId} → v${saved.sys.version}`)
            await this.client.contentType.publish(
              { contentTypeId },
              saved,
            )
            console.log(`[Contentful] Published ${contentTypeId}`)
            return
          } catch (err: any) {
            console.warn(`[Contentful] Attempt ${attempt + 1} to publish ${contentTypeId} failed:`, err?.message ?? err)
            // Refetch to get the current version
            const refetched = await this.getContentType(contentTypeId)
            if (refetched) version = refetched.sys.version ?? version
          }
        }
        console.warn(`[Contentful] Could not publish ${contentTypeId} after retries`)
      } catch (err: any) {
        if (err?.status === 409) {
          // Already exists (409 Conflict) — try to publish it
          console.log(`[Contentful] ${contentTypeId} already exists (409), attempting to publish...`)
          await this.tryPublishExisting(contentTypeId, name, fields)
          return
        }
        console.warn(`[Contentful] Failed to create ${contentTypeId}:`, err?.message ?? err)
      }
      return
    }

    // Already exists — try to publish if not yet published
    if (!existing.sys.publishedVersion || existing.sys.publishedVersion < (existing.sys.version ?? 0)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.client.contentType.publish({ contentTypeId }, existing)
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
      const updated = await this.client.contentType.update(
        { contentTypeId },
        { ...existing, name, fields, displayField: fields[0]?.id },
      )
      await this.client.contentType.publish({ contentTypeId }, updated)
      console.log(`[Contentful] Updated + published ${contentTypeId}`)
    }
  }

  private async tryPublishExisting(
    contentTypeId: string,
    name: string,
    fields: ContentTypeField[],
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 3000))
      const existing = await this.getContentType(contentTypeId)
      if (existing) {
        if (!existing.sys.publishedVersion || existing.sys.publishedVersion < (existing.sys.version ?? 0)) {
          try {
            const saved = await this.client.contentType.update(
              { contentTypeId },
              { ...existing, name, fields, displayField: fields[0]?.id },
            )
            await this.client.contentType.publish({ contentTypeId }, saved)
            console.log(`[Contentful] Published existing ${contentTypeId}`)
            return
          } catch (err: any) {
            console.warn(`[Contentful] Attempt ${attempt + 1} to publish existing ${contentTypeId}:`, err?.message ?? err)
          }
        } else {
          console.log(`[Contentful] ${contentTypeId} already published`)
          return
        }
      }
    }
    console.warn(`[Contentful] Could not publish existing ${contentTypeId} after retries`)
  }

  // ─── Entries ─────────────────────────────────────────────────────────────

  async getEntry(entryId: string): Promise<any | null> {
    try {
      return await this.client.entry.get({ entryId })
    } catch (err: any) {
      if (err?.status === 404) return null
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
      entry = await this.client.entry.update(
        { entryId },
        { ...existing, fields },
      )
    } else {
      entry = await this.client.entry.createWithId(
        { entryId, contentTypeId },
        { fields },
      )
    }

    return this.client.entry.publish({ entryId }, entry)
  }

  async unpublishEntry(entryId: string): Promise<any> {
    const entry = await this.getEntry(entryId)
    if (!entry) return null
    return this.client.entry.unpublish({ entryId }, entry)
  }

  async deleteEntry(entryId: string): Promise<void> {
    await this.client.entry.delete({ entryId })
  }

  // ─── Asset Uploads ────────────────────────────────────────────────────────

  async uploadFile(_fileName: string, data: ArrayBuffer, _contentType: string): Promise<string> {
    const upload = await this.client.upload.create({}, { file: data })
    return upload.sys.id
  }

  async createAssetFromUpload(
    uploadId: string,
    title: string,
    fileName: string,
    contentType: string,
  ): Promise<{ id: string; url: string }> {
    const asset = await this.client.asset.create({}, {
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
    })

    // Process the asset (triggers Contentful image processing)
    const processed = await this.client.asset.processForLocale({}, asset, 'en-US')

    // Publish
    const published = await this.client.asset.publish(
      { assetId: processed.sys.id },
      processed,
    )

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
}
