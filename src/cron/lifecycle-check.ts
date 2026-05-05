import type { LeapifyBindings } from '../types'
import { createDb } from '../db'

/**
 * Cron: every hour (`0 * * * *`)
 *
 * Detects when siteEndsAt has passed and triggers the
 * Contentful → D1 content snapshot. Retries automatically
 * every hour until the snapshot succeeds.
 */
export async function lifecycleCheck(
  env: LeapifyBindings,
  ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.DB)
  const now = Math.floor(Date.now() / 1000)

  // Read site_ends_at and snapshot_completed from site_config
  const rows = await db.query.siteConfig.findMany({
    where: (t, { inArray }) => inArray(t.key, ['site_ends_at', 'snapshot_completed']),
  })

  const config = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  const siteEndsAt = config['site_ends_at'] as number | undefined
  const snapshotCompleted = config['snapshot_completed'] as boolean | undefined

  if (!siteEndsAt || snapshotCompleted) return

  if (now >= siteEndsAt) {
    console.log('[lifecycle-check] siteEndsAt passed — triggering content snapshot.')

    // Queue the snapshot job (processed by queue consumer)
    // Don't set snapshot_completed here — the queue handler sets it on success
    if (env.EMAIL_QUEUE) {
      ctx.waitUntil(
        env.EMAIL_QUEUE.send({ type: 'snapshot_content', payload: { triggeredAt: now } }),
      )
    }
  }
}
