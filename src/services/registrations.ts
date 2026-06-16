import { eq } from "drizzle-orm";
import type { LeapifyDb } from "../db";
import { registrations } from "../db/schema/registrations";
import { events } from "../db/schema/classes";

export interface RegistrationRecord {
  slug: string;
  eventId: string;
  submittedAt: number;
}

export class RegistrationsService {
  constructor(private readonly db: LeapifyDb) {}

  /**
   * Upsert a batch of respondents for an event.
   * Called by webhook (single new entry) and reconcile cron (all entries).
   * Safe to call repeatedly — unique constraint on (eventId, email).
   */
  async upsertRespondents(
    eventId: string,
    respondents: { email: string; submittedAt: number }[],
  ): Promise<void> {
    if (respondents.length === 0) return;

    for (const r of respondents) {
      await this.db
        .insert(registrations)
        .values({
          eventId,
          email: r.email,
          submittedAt: r.submittedAt,
        })
        .onConflictDoNothing({
          target: [registrations.eventId, registrations.email],
        });
    }
  }

  /**
   * Look up whether a student (by email) has registered for any event.
   * Returns the first match with the event slug.
   */
  async getRegistrationByEmail(
    email: string,
  ): Promise<RegistrationRecord | null> {
    const row = await this.db
      .select({
        slug: events.slug,
        eventId: registrations.eventId,
        submittedAt: registrations.submittedAt,
      })
      .from(registrations)
      .innerJoin(events, eq(registrations.eventId, events.id))
      .where(eq(registrations.email, email))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    return row;
  }
}
