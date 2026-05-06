import { and, eq } from "drizzle-orm";
import type { LeapifyBindings } from "../types";
import { createDb } from "../db";
import { events } from "../db/schema/events";

/**
 * Parse a human-readable dateTime (e.g. "May 7, 2026") and optional startTime
 * (e.g. "14:30") into a Unix timestamp (seconds). Returns null if unparseable.
 */
function parseStartTimestamp(
  dateTime: string | null,
  startTime: string | null,
): number | null {
  if (!dateTime) return null;
  const combined = startTime ? `${dateTime} ${startTime}` : dateTime;
  const ms = Date.parse(combined);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * Cron: every hour (`0 * * * *`)
 *
 * Scans published events for those approaching their start time.
 * Queues send_reminder_email jobs for events within the 24h and 1h windows.
 */
export async function reminderEmails(env: LeapifyBindings): Promise<void> {
  if (!env.EMAIL_QUEUE) {
    console.warn(
      "[reminder-emails] EMAIL_QUEUE binding not configured, skipping.",
    );
    return;
  }

  const hasSes = !!(
    env.SES_REGION &&
    env.SES_ACCESS_KEY_ID &&
    env.SES_SECRET_ACCESS_KEY
  );
  const hasResend = !!env.RESEND_API_KEY;
  if (!hasSes && !hasResend) {
    console.warn(
      "[reminder-emails] No email providers configured. Skipping reminders.",
    );
    return;
  }

  const db = createDb(env.DB);
  const now = Math.floor(Date.now() / 1000);

  // Fetch published events that haven't had 24h reminders sent
  // We filter in-memory since startsAt is derived from dateTime + startTime
  const candidates24h = await db.query.events.findMany({
    where: and(
      eq(events.status, "published"),
      eq(events.reminder24hSent, false),
    ),
    columns: {
      id: true,
      dateTime: true,
      startTime: true,
    },
  });

  for (const event of candidates24h) {
    const startsAt = parseStartTimestamp(event.dateTime, event.startTime);
    if (!startsAt) continue;

    const hoursUntil = (startsAt - now) / 3600;
    if (hoursUntil <= 25 && hoursUntil >= 23) {
      await env.EMAIL_QUEUE.send({
        type: "send_reminder_email",
        payload: { eventId: event.id, hoursBeforeEvent: 24 },
      });
    }
  }

  // Fetch published events that haven't had 1h reminders sent
  const candidates1h = await db.query.events.findMany({
    where: and(
      eq(events.status, "published"),
      eq(events.reminder1hSent, false),
    ),
    columns: {
      id: true,
      dateTime: true,
      startTime: true,
    },
  });

  for (const event of candidates1h) {
    const startsAt = parseStartTimestamp(event.dateTime, event.startTime);
    if (!startsAt) continue;

    const hoursUntil = (startsAt - now) / 3600;
    if (hoursUntil <= 1.5 && hoursUntil >= 0) {
      await env.EMAIL_QUEUE.send({
        type: "send_reminder_email",
        payload: { eventId: event.id, hoursBeforeEvent: 1 },
      });
    }
  }
}
