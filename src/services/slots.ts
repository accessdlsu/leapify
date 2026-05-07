import { eq, sql } from 'drizzle-orm'
import type { LeapifyDb } from '../db'
import { events } from '../db/schema/classes'
import type { CacheService } from './cache'

const SLOT_KV_PREFIX = 'slots:'

export interface SlotInfo {
  available: number
  total: number
  registered: number
  isFull: boolean
}

/**
 * Manages real-time slot counts using a local D1 counter + KV cache.
 * Google Forms Watch webhook increments the counter; reads go through KV.
 *
 * CF Cache (Cache-Control: public, max-age=5) sits in front of the /slots
 * endpoint, so KV is only read once per 5-second window per edge location.
 */
export class SlotsService {
  constructor(
    private readonly db: LeapifyDb,
    private readonly cache: CacheService,
  ) {}

  kvKey(slug: string) {
    return `${SLOT_KV_PREFIX}${slug}`
  }

  /**
   * Read current slot info — KV first, D1 on miss.
   */
  async getSlots(slug: string): Promise<SlotInfo | null> {
    // Try KV first
    const cached = await this.cache.get<SlotInfo>(this.kvKey(slug))
    if (cached) return cached

    // Fall back to D1
    return this.refreshFromDb(slug)
  }

  /**
   * Atomically increment registered_slots in D1 and update KV.
   * Called by the Google Forms Watch webhook handler.
   */
  async increment(slug: string): Promise<SlotInfo | null> {
    await this.db
      .update(events)
      .set({ registeredSlots: sql`${events.registeredSlots} + 1` })
      .where(eq(events.slug, slug))

    return this.refreshFromDb(slug)
  }

  /**
   * Atomically decrement registered_slots in D1 and update KV.
   * Used during reconciliation drift correction (not from user actions).
   */
  async decrement(slug: string): Promise<SlotInfo | null> {
    await this.db
      .update(events)
      .set({
        registeredSlots: sql`MAX(0, ${events.registeredSlots} - 1)`,
      })
      .where(eq(events.slug, slug))

    return this.refreshFromDb(slug)
  }

  /**
   * Set registered_slots to a specific value (used by reconciliation cron).
   */
  async correctCount(slug: string, actualCount: number): Promise<void> {
    await this.db
      .update(events)
      .set({ registeredSlots: actualCount })
      .where(eq(events.slug, slug))

    await this.invalidate(slug)
  }

  /**
   * Read from D1, write to KV, and return slot info.
   */
  async refreshFromDb(slug: string): Promise<SlotInfo | null> {
    const event = await this.db.query.events.findFirst({
      where: eq(events.slug, slug),
      columns: { maxSlots: true, registeredSlots: true },
    })

    if (!event) return null

    const info: SlotInfo = {
      total: event.maxSlots,
      registered: event.registeredSlots,
      available: Math.max(0, event.maxSlots - event.registeredSlots),
      isFull: event.registeredSlots >= event.maxSlots,
    }

    // Cache with no TTL — explicitly invalidated on every write
    await this.cache.set(this.kvKey(slug), info)

    return info
  }

  /**
   * Invalidate the KV cache for a specific event.
   */
  async invalidate(slug: string): Promise<void> {
    await this.cache.del(this.kvKey(slug))
  }
}
