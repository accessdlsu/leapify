import { isNotNull } from "drizzle-orm";
import type { LeapifyBindings } from "../types";
import { createDb } from "../db";
import { events } from "../db/schema/classes";
import { CacheService } from "../services/cache";
import { GFormsService } from "../services/gforms";
import { SlotsService } from "../services/slots";

const LOCK_KEY = "cron:reconcile-slots:lock";
const LOCK_TTL = 300; // 5 minutes

/**
 * Cron: every 5 minutes (`*\/5 * * * *`)
 *
 * Compares D1 registered_slots against actual Google Forms response counts.
 * Corrects any drift caused by missed webhook notifications.
 * Uses a distributed lock (KV) to ensure only one instance runs.
 */
export async function reconcileSlots(env: LeapifyBindings): Promise<void> {
  const db = createDb(env.DB);
  const cache = new CacheService(env.KV);
  const gforms = new GFormsService(env.GFORMS_SERVICE_ACCOUNT_JSON);
  const slots = new SlotsService(db);

  // Distributed lock
  const lock = await cache.get<string>(LOCK_KEY);
  if (lock) {
    console.log("[reconcile-slots] Lock held, skipping.");
    return;
  }
  await cache.set(LOCK_KEY, "1", LOCK_TTL);

  try {
    // Fetch all published events with a Google Form
    const publishedEvents = await db.query.events.findMany({
      where: isNotNull(events.gformsId),
      columns: { id: true, slug: true, gformsId: true, registeredSlots: true },
    });
    const eventsWithForms = publishedEvents.filter((e) => e.gformsId);
    let corrected = 0;

    for (const event of eventsWithForms) {
      try {
        const googleCount = await gforms.getExactResponseCount(event.gformsId!);
        const localCount = event.registeredSlots;

        if (googleCount !== localCount) {
          console.warn(
            `[reconcile-slots] Drift on "${event.slug}": local=${localCount}, google=${googleCount}`,
          );
          await slots.correctCount(event.slug, googleCount);
          corrected++;
        }
      } catch (err) {
        // Don't let one form failure abort the whole reconciliation
        console.error(`[reconcile-slots] Error checking "${event.slug}":`, err);
      }
    }

    console.log(
      `[reconcile-slots] Checked ${eventsWithForms.length} events, corrected ${corrected}.`,
    );
  } finally {
    await cache.del(LOCK_KEY);
  }
}
