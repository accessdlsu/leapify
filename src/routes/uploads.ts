import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { LeapifyEnv } from '../types'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { badRequest, serviceUnavailable, notFound } from '../lib/errors'

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
 * GET /uploads/* — public
 *
 * Serves an image from the R2 `FILES` bucket.
 */
uploadsRoute.get(
  '/*',
  describeRoute({
    tags: ['Uploads'],
    summary: 'Serve an image from R2 storage',
    responses: {
      200: { description: 'Image file' },
      404: { description: 'Image not found' },
    },
  }),
  async (c) => {
  const bucket = c.env.FILES
  if (!bucket) {
    throw serviceUnavailable('File storage (R2) is not configured.')
  }

  // Get the path after /uploads/
  const path = c.req.path.split('/uploads/')[1]
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
 * POST /uploads — admin only
 *
 * Accepts multipart/form-data with a single `file` field.
 * Stores the file in the R2 `FILES` bucket under a timestamped path and
 * returns the public URL.
 */
uploadsRoute.post(
  '/',
  describeRoute({
    tags: ['Uploads'],
    summary: 'Upload an image to R2 storage (admin)',
    responses: {
      201: { description: 'Image uploaded successfully' },
      400: { description: 'Invalid file or MIME type' },
      503: { description: 'R2 storage not configured' },
    },
  }),
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

    const url = `/api/uploads/${key}`

    return c.json(
      {
        data: {
          url,
          key,
          size: file.size,
          contentType,
        },
      },
      201,
    )
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
