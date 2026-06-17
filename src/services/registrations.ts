import { and, eq, asc } from "drizzle-orm";
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
  classes: { slug: string; title: string; classCode: string | null; submittedAt: number }[];
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
   * Full two-way sync of respondents for an event.
   * Called by reconcile (cron + admin endpoint).
   * Deletes rows whose email is no longer in the incoming set, then insert-or-ignores the rest.
   */
  async syncRespondents(
    eventId: string,
    respondents: { email: string; submittedAt: number }[],
  ): Promise<void> {
    // Fetch current emails from D1 (1 param, no limit)
    const existing = await this.db
      .select({ email: registrations.email })
      .from(registrations)
      .where(eq(registrations.eventId, eventId));

    const existingSet = new Set(existing.map((r) => r.email));
    const incomingSet = new Set(respondents.map((r) => r.email));

    const stmts = [
      // Delete rows no longer in Google Forms (2 params each)
      ...[...existingSet]
        .filter((email) => !incomingSet.has(email))
        .map((email) =>
          this.db
            .delete(registrations)
            .where(and(eq(registrations.eventId, eventId), eq(registrations.email, email))),
        ),
      // Insert new respondents
      ...respondents
        .filter((r) => !existingSet.has(r.email))
        .map((r) =>
          this.db
            .insert(registrations)
            .values({ eventId, email: r.email, submittedAt: r.submittedAt })
            .onConflictDoNothing({ target: [registrations.eventId, registrations.email] }),
        ),
    ];

    if (stmts.length > 0) {
      await this.db.batch(stmts as [typeof stmts[0], ...typeof stmts]);
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
        classCode: events.classCode,
        submittedAt: registrations.submittedAt,
      })
      .from(registrations)
      .innerJoin(events, eq(registrations.eventId, events.id))
      .orderBy(asc(registrations.email), asc(registrations.submittedAt));

    const byEmail = new Map<string, { slug: string; title: string; classCode: string | null; submittedAt: number }[]>();
    for (const row of rows) {
      if (!byEmail.has(row.email)) byEmail.set(row.email, []);
      byEmail.get(row.email)!.push({ slug: row.slug, title: row.title, classCode: row.classCode, submittedAt: row.submittedAt });
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
