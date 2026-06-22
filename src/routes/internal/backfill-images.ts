import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { isNull, eq } from 'drizzle-orm'
import type { LeapifyEnv } from '../../types'
import { createDb } from '../../db'
import { authUser, authAccount } from '../../db/schema/auth'
import { internalMiddleware } from '../../auth/middleware'

export const backfillImagesRoute = new Hono<LeapifyEnv>()

/**
 * POST /internal/backfill-images
 *
 * One-off backfill: decodes the stored Google id_token for every user
 * whose image is NULL and writes the picture URL from the JWT payload.
 *
 * Safe to run multiple times — only processes rows where image IS NULL.
 */
backfillImagesRoute.post(
  '/',
  describeRoute({
    tags: ['Internal'],
    summary: 'Backfill user profile images',
    description: 'Decodes stored Google id_tokens and writes the picture URL for users with no image. Safe to run multiple times.',
    responses: {
      200: { description: 'Backfill complete' },
    },
  }),
  internalMiddleware,
  async (c) => {
  const db = createDb(c.env.DB)

  // Fetch all Google accounts whose linked user has no image
  const rows = await db
    .select({ userId: authAccount.userId, idToken: authAccount.idToken })
    .from(authAccount)
    .innerJoin(authUser, eq(authAccount.userId, authUser.id))
    .where(isNull(authUser.image))
    .all()

  // Filter to Google provider rows (innerJoin already narrows to null-image users,
  // but an account row could be a different provider if somehow added later)
  const googleRows = rows.filter(r => r.idToken)

  let updated = 0
  let skipped = 0

  for (const row of googleRows) {
    const picture = extractPicture(row.idToken!)
    if (!picture) {
      skipped++
      continue
    }
    await db
      .update(authUser)
      .set({ image: picture })
      .where(eq(authUser.id, row.userId))
    updated++
  }

  // Sample the first skipped token for diagnosis
  const firstSkipped = googleRows.find(r => !extractPicture(r.idToken!))
  const sample = firstSkipped ? diagnosePicture(firstSkipped.idToken!) : null

  console.log(`[backfill-images] updated=${updated} skipped=${skipped}`)
  return c.json({ updated, skipped, sample })
})

function extractPicture(idToken: string): string | null {
  try {
    const parts = idToken.split('.')
    if (parts.length !== 3) return null
    // JWT uses base64url; atob() requires standard base64
    const base64 = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(parts[1].length + (4 - parts[1].length % 4) % 4, '=')
    const payload = JSON.parse(atob(base64)) as { picture?: string }
    return payload.picture ?? null
  } catch {
    return null
  }
}

function diagnosePicture(idToken: string): Record<string, unknown> {
  const parts = idToken.split('.')
  if (parts.length !== 3) return { error: `unexpected part count: ${parts.length}`, raw: idToken.slice(0, 80) }
  try {
    const base64 = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(parts[1].length + (4 - parts[1].length % 4) % 4, '=')
    const payload = JSON.parse(atob(base64)) as Record<string, unknown>
    return { keys: Object.keys(payload), hasPicture: 'picture' in payload, picture: payload.picture }
  } catch (e) {
    return { error: String(e), rawPayloadSlice: parts[1].slice(0, 80) }
  }
}
