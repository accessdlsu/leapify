import { Hono } from 'hono'
import type { LeapifyEnv } from '../types'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { badRequest, serviceUnavailable, notFound } from '../lib/errors'
import { ContentfulManagement } from '../services/contentful-management'

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])

/** 10 MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024

export const uploadsRoute = new Hono<LeapifyEnv>()

/**
 * GET /uploads/images/* — public
 *
 * Serves an image from the R2 `FILES` bucket.
 */
uploadsRoute.get('/images/*', async (c) => {
  const bucket = c.env.FILES
  if (!bucket) {
    throw serviceUnavailable('File storage (R2) is not configured.')
  }

  // Get the path after /images/
  const path = c.req.path.split('/uploads/images/')[1]
  if (!path) throw notFound('Image')

  const object = await bucket.get(path)
  if (!object) throw notFound('Image')

  const headers: Record<string, string> = {
    etag: object.httpEtag,
    // Cache at the edge/browser for 1 month
    "Cache-Control": "public, max-age=2592000, immutable",
  };

  if (object.httpMetadata?.contentType) {
    headers['Content-Type'] = object.httpMetadata.contentType
  }
  if (object.httpMetadata?.cacheControl) {
    headers['Cache-Control'] = object.httpMetadata.cacheControl
  }

  return c.body(object.body as unknown as ReadableStream, 200, headers)
})

/**
 * POST /uploads/images — admin only
 *
 * Accepts multipart/form-data with a single `file` field.
 * Stores the file in the R2 `FILES` bucket under a timestamped path and
 * returns the public URL.
 */
uploadsRoute.post(
  '/images',
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const bucket = c.env.FILES
    if (!bucket) {
      throw serviceUnavailable('File storage (R2) is not configured.')
    }

    // Parse multipart body
    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch {
      throw badRequest('Request body must be multipart/form-data.')
    }

    const file = formData.get('file')
    if (!(file instanceof File)) {
      throw badRequest('A "file" field is required.')
    }

    // Validate MIME type
    const contentType = file.type || 'application/octet-stream'
    if (!ALLOWED_MIME_TYPES.has(contentType)) {
      throw badRequest(
        `Unsupported file type "${contentType}".`,
      )
    }

    // Validate size
    if (file.size > MAX_FILE_SIZE) {
      throw badRequest('File exceeds 10MB limit.')
    }

    // Build a storage key
    const folder = sanitizeFolder(formData.get('folder'))
    const ext = extensionFromMime(contentType)
    const ts = Date.now()
    const rand = Math.random().toString(36).slice(2, 8)
    const key = `${folder}/${ts}-${rand}.${ext}`

    // Upload to R2
    const arrayBuffer = await file.arrayBuffer()
    await bucket.put(key, arrayBuffer, {
      httpMetadata: { contentType },
      customMetadata: { uploadedAt: new Date().toISOString() },
    })

    // Construct URL based on the current request
    const url = new URL(c.req.url)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${key}`
    url.search = ''

    return c.json(
      {
        data: {
          url: url.toString(),
          key,
          size: file.size,
          contentType,
        },
      },
      201,
    )
  },
)

/**
 * POST /uploads/contentful — admin only
 *
 * Uploads a file directly to Contentful as a published Asset.
 * Returns the Contentful asset sys.id and CDN URL.
 */
uploadsRoute.post(
  '/contentful',
  authMiddleware,
  adminMiddleware,
  async (c) => {
    if (!ContentfulManagement.isConfigured(c.env.CONTENTFUL_SPACE_ID, c.env.CONTENTFUL_MANAGEMENT_TOKEN)) {
      throw serviceUnavailable('Contentful Management API credentials not configured.')
    }

    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch {
      throw badRequest('Request body must be multipart/form-data.')
    }

    const file = formData.get('file')
    if (!(file instanceof File)) {
      throw badRequest('A "file" field is required.')
    }

    const contentType = file.type || 'application/octet-stream'
    if (!ALLOWED_MIME_TYPES.has(contentType)) {
      throw badRequest(`Unsupported file type "${contentType}".`)
    }

    if (file.size > MAX_FILE_SIZE) {
      throw badRequest('File exceeds 10MB limit.')
    }

    const mgmt = new ContentfulManagement(
      c.env.CONTENTFUL_SPACE_ID!,
      c.env.CONTENTFUL_MANAGEMENT_TOKEN!,
      c.env.CONTENTFUL_ENVIRONMENT,
    )

    const arrayBuffer = await file.arrayBuffer()
    const uploadId = await mgmt.uploadFile(file.name, arrayBuffer, contentType)
    const asset = await mgmt.createAssetFromUpload(uploadId, file.name, file.name, contentType)

    return c.json({
      data: {
        assetId: asset.id,
        url: asset.url,
        size: file.size,
        contentType,
      },
    }, 201)
  },
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeFolder(raw: FormDataEntryValue | null): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'images'
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9\-_/]/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '')
    || 'images'
}

function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
  }
  return map[mime] ?? 'bin'
}
