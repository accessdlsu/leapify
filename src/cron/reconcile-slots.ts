import { isNotNull, eq } from "drizzle-orm";
import type { EventStatus } from "../db/schema/classes";
import type { LeapifyBindings } from "../types";
import { createDb } from "../db";
import { events } from "../db/schema/classes";
import { CacheService } from "../services/cache";
import { GFormsService } from "../services/gforms";
import { SlotsService } from "../services/slots";
import { RegistrationsService } from "../services/registrations";

export const RECONCILE_LOCK_KEY = "cron:reconcile-slots:lock";
export const RECONCILE_LAST_RUN_KEY = "cron:reconcile-slots:last-run";
const LOCK_TTL = 300; // 5 minutes

/**
 * Cron: every 5 minutes (`*\/5 * * * *`)
 *
 * Compares D1 registered_slots against actual Google Forms response counts.
 * Corrects any drift caused by missed webhook notifications.
 * Also fully syncs respondent emails into the registrations table (backup sync).
 * Uses a distributed lock (KV) to ensure only one instance runs.
 */
export async function reconcileSlots(env: LeapifyBindings): Promise<void> {
  const db = createDb(env.DB);
  const cache = new CacheService(env.KV);
  const gforms = new GFormsService(env.GFORMS_SERVICE_ACCOUNT_JSON);
  const slots = new SlotsService(db);
  const regs = new RegistrationsService(db);

  // Distributed lock
  const lock = await cache.get<string>(RECONCILE_LOCK_KEY);
  if (lock) {
    console.log("[reconcile-slots] Lock held, skipping.");
    return;
  }
  await cache.set(RECONCILE_LOCK_KEY, "1", LOCK_TTL);

  const STATUS_PRIORITY: Record<EventStatus, number> = {
    published: 0,
    queued: 1,
    draft: 2,
    ended: 3,
    cancelled: 4,
  };

  const autoClose = (await cache.get<boolean>('config:auto_close_registration')) ?? true;

  try {
    // Fetch all events with a Google Form, regardless of status
    const allEvents = await db.query.events.findMany({
      where: isNotNull(events.gformsId),
      columns: { id: true, slug: true, gformsId: true, registeredSlots: true, status: true, maxSlots: true, registrationEnabled: true, registrationClosesAt: true },
    });
    const eventsWithForms = allEvents
      .filter((e) => e.gformsId)
      .sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
    let corrected = 0;

    for (const event of eventsWithForms) {
      try {
        const responses = await gforms.getAllResponses(event.gformsId!);
        const googleCount = responses.length;
        const localCount = event.registeredSlots;

        // Correct slot drift
        if (googleCount !== localCount) {
          console.warn(
            `[reconcile-slots] Drift on "${event.slug}": local=${localCount}, google=${googleCount}`,
          );
          await slots.correctCount(event.slug, googleCount);
          corrected++;
        }

        // Sync registrations table (catches any emails missed by webhook)
        const respondents = responses
          .filter((r) => r.respondentEmail)
          .map((r) => ({
            email: r.respondentEmail!,
            submittedAt: Math.floor(new Date(r.createTime).getTime() / 1000),
          }));
        await regs.syncRespondents(event.id, respondents);

        // Auto-close if full or past deadline
        if (autoClose && event.registrationEnabled) {
          const now = Math.floor(Date.now() / 1000);
          const isFull = event.maxSlots > 0 && googleCount >= event.maxSlots;
          const isPastDeadline = !!event.registrationClosesAt && event.registrationClosesAt <= now;

          if (isFull || isPastDeadline) {
            try {
              await db.update(events).set({ registrationEnabled: false }).where(eq(events.slug, event.slug));
              await gforms.setAcceptingResponses(event.gformsId!, false);
              const reason = isFull ? 'full' : 'deadline passed';
              console.log(`[reconcile-slots] Auto-closed "${event.slug}" (${reason})`);
            } catch (err) {
              console.error(`[reconcile-slots] Failed to auto-close "${event.slug}":`, err);
            }
          }
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
    await cache.del(RECONCILE_LOCK_KEY);
    await cache.set(RECONCILE_LAST_RUN_KEY, Date.now().toString());
  }
}
