import { and, eq, lte } from 'drizzle-orm'
import type { LeapifyBindings } from '../types'
import { createDb } from '../db'
import { events } from '../db/schema/classes'
import { GFormsService } from '../services/gforms'

const RENEWAL_WINDOW = 86400 // renew watches expiring within 24 hours

/**
 * Cron: daily at midnight (`0 0 * * *`)
 *
 * Finds Google Forms Watches expiring within 24 hours and renews them.
 * Watches have a hard 7-day TTL; this cron keeps them alive indefinitely.
 */
export async function renewWatches(env: LeapifyBindings): Promise<void> {
  const db = createDb(env.DB)
  const gforms = new GFormsService(env.GFORMS_SERVICE_ACCOUNT_JSON)

  const now = Math.floor(Date.now() / 1000)
  const threshold = now + RENEWAL_WINDOW

  const expiring = await db.query.events.findMany({
    where: and(
      eq(events.status, 'published'),
      lte(events.watchExpiresAt, threshold),
    ),
    columns: { id: true, slug: true, gformsId: true, watchId: true, watchExpiresAt: true },
  })

  const watchEvents = expiring.filter((e) => e.gformsId && e.watchId)
  let renewed = 0

  for (const event of watchEvents) {
    try {
      const result = await gforms.renewWatch(event.gformsId!, event.watchId!)
      const newExpiry = Math.floor(new Date(result.expireTime).getTime() / 1000)

      await db
        .update(events)
        .set({ watchExpiresAt: newExpiry })
        .where(eq(events.id, event.id))

      renewed++
      console.log(`[renew-watches] Renewed Watch for "${event.slug}", expires ${result.expireTime}`)
    } catch (err) {
      console.error(`[renew-watches] Failed to renew Watch for "${event.slug}":`, err)
    }
  }

  console.log(`[renew-watches] Renewed ${renewed}/${watchEvents.length} watches.`)
}
