import { eq, and, lte, sql } from 'drizzle-orm'
import type { LeapifyBindings } from '../types'
import { createDb } from '../db'
import { events } from '../db/schema/classes'
import { CacheService } from '../services/cache'

/**
 * Cron: every 1 minute (`* * * * *`)
 *
 * Finds all events with status='queued' whose release_at has passed,
 * publishes them atomically, and invalidates the events list KV cache.
 */
export async function batchRelease(env: LeapifyBindings): Promise<void> {
  const db = createDb(env.DB)
  const cache = new CacheService(env.KV)

  const now = Math.floor(Date.now() / 1000)

  // Fetch queued events ready to publish
  const toPublish = await db.query.events.findMany({
    where: and(eq(events.status, 'queued'), lte(events.releaseAt, now)),
    columns: { id: true, slug: true },
  })

  if (toPublish.length === 0) return

  const ids = toPublish.map((e) => e.id)

  // Batch update to 'published'
  await db
    .update(events)
    .set({ status: 'published', publishedAt: sql`(unixepoch())` })
    .where(
      // Drizzle doesn't have inArray for D1; use raw SQL for batch
      sql`${events.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )

  // Invalidate events list cache
  await cache.del('events:list')
  await cache.del('events:etag')

  console.log(
    `[batch-release] Published ${toPublish.length} events:`,
    toPublish.map((e) => e.slug).join(', '),
  )
}
