import { eq } from "drizzle-orm";
import type { LeapifyDb } from "../db";
import { registrations } from "../db/schema/registrations";
import { events } from "../db/schema/classes";

export interface RegistrationRecord {
  slug: string;
  eventId: string;
  submittedAt: number;
}

export interface MultiRegistrationEntry {
  email: string;
  classes: { slug: string; title: string; submittedAt: number }[];
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
  async getMultiRegistrations(): Promise<MultiRegistrationEntry[]> {
    const rows = await this.db
      .select({
        email: registrations.email,
        slug: events.slug,
        title: events.title,
        submittedAt: registrations.submittedAt,
      })
      .from(registrations)
      .innerJoin(events, eq(registrations.eventId, events.id))
      .orderBy(registrations.email, registrations.submittedAt);

    const byEmail = new Map<string, { slug: string; title: string; submittedAt: number }[]>();
    for (const row of rows) {
      if (!byEmail.has(row.email)) byEmail.set(row.email, []);
      byEmail.get(row.email)!.push({ slug: row.slug, title: row.title, submittedAt: row.submittedAt });
    }

    return Array.from(byEmail.entries())
      .filter(([, classes]) => classes.length > 1)
      .map(([email, classes]) => ({ email, classes }));
  }

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
