import { eq, sql } from 'drizzle-orm'
import type { LeapifyDb } from '../db'
import { events } from '../db/schema/classes'

export interface SlotInfo {
  total: number
  registered: number
}

/**
 * Manages real-time slot counts using D1 directly (no KV cache).
 * Google Forms Watch webhook increments the counter.
 */
export class SlotsService {
  constructor(private readonly db: LeapifyDb) {}

  /**
   * Read current slot info from D1.
   */
  async getSlots(slug: string): Promise<SlotInfo | null> {
    const event = await this.db.query.events.findFirst({
      where: eq(events.slug, slug),
      columns: { maxSlots: true, registeredSlots: true },
    })

    if (!event) return null

    return {
      total: event.maxSlots,
      registered: event.registeredSlots,
    }
  }

  /**
   * Atomically increment registered_slots in D1.
   * Called by the Google Forms Watch webhook handler.
   */
  async increment(slug: string): Promise<SlotInfo | null> {
    await this.db
      .update(events)
      .set({ registeredSlots: sql`${events.registeredSlots} + 1` })
      .where(eq(events.slug, slug))

    return this.getSlots(slug)
  }

  /**
   * Atomically decrement registered_slots in D1.
   * Used during reconciliation drift correction (not from user actions).
   */
  async decrement(slug: string): Promise<SlotInfo | null> {
    await this.db
      .update(events)
      .set({
        registeredSlots: sql`MAX(0, ${events.registeredSlots} - 1)`,
      })
      .where(eq(events.slug, slug))

    return this.getSlots(slug)
  }

  /**
   * Set registered_slots to a specific value (used by reconciliation cron).
   */
  async correctCount(slug: string, actualCount: number): Promise<void> {
    await this.db
      .update(events)
      .set({ registeredSlots: actualCount })
      .where(eq(events.slug, slug))
  }
}
