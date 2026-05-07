import { eq } from 'drizzle-orm'
import type { LeapifyBindings } from '../types'
import type { LeapifyJob } from './jobs'
import { createDb } from '../db'
import { events } from '../db/schema/classes'
import { createEmailRouter, type EmailRouter } from '../services/email'
import { buildReminderEmail } from '../services/resend'
import { GFormsService } from '../services/gforms'

/**
 * CF Queue consumer handler.
 * Export from the consumer repo's worker entry like:
 *
 * ```ts
 * import { createQueueHandler } from 'leapify'
 * export const queue = createQueueHandler
 * ```
 */
export function createQueueHandler(env: LeapifyBindings) {
  return async (batch: MessageBatch<LeapifyJob>): Promise<void> => {
    const db = createDb(env.DB)
    const email = createEmailRouter(env)
    const gforms = new GFormsService(env.GFORMS_SERVICE_ACCOUNT_JSON)

    for (const message of batch.messages) {
      try {
        await processJob(message.body, { db, email, gforms, env })
        message.ack()
      } catch (err) {
        console.error(`[Queue] Failed to process job ${message.body.type}:`, err)
        message.retry()
      }
    }
  }
}

async function processJob(
  job: LeapifyJob,
  services: {
    db: ReturnType<typeof createDb>
    email: EmailRouter | null
    gforms: GFormsService
    env: LeapifyBindings
  },
): Promise<void> {
  const { db, email, gforms } = services

  switch (job.type) {
    case 'send_email': {
      if (!email) throw new Error('Email provider not configured')
      const result = await email.sendEmail(job.payload)
      console.log(`[Queue] send_email dispatched via ${result.provider} (id=${result.id})`)
      break
    }

    case 'send_reminder_email': {
      if (!email) throw new Error('Email provider not configured')

      const event = await db.query.events.findFirst({
        where: eq(events.id, job.payload.eventId),
        with: { organization: true },
      })
      if (!event?.gformsId) break

      const emails = await gforms.getRespondentEmails(event.gformsId)
      if (emails.length === 0) break

      const isDay = job.payload.hoursBeforeEvent === 24
      const subject = isDay
        ? `Reminder: "${event.title}" is tomorrow!`
        : `Reminder: "${event.title}" is in 1 hour!`
      const html = buildReminderEmail({
        title: event.title,
        organization: event.organization?.name ?? null,
        dateTime: event.dateTime,
        startTime: event.startTime,
        venue: event.venue,
        gformsUrl: event.gformsUrl,
      })

      const BATCH_SIZE = 50
      const chunks: string[][] = []
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        chunks.push(emails.slice(i, i + BATCH_SIZE))
      }
      const failures: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        try {
          await email.sendEmail({ to: chunk, subject, html })
        } catch (err) {
          failures.push(...chunk)
          console.error(
            `[Queue] send_reminder_email: ${failures.length}/${chunk.length} messages failed in batch ${i / BATCH_SIZE + 1}`,
            err,
          )
        }
      }

      const field = isDay ? 'reminder24hSent' : 'reminder1hSent'
      await db.update(events).set({ [field]: true }).where(eq(events.id, event.id))
      break
    }

    case 'audit_log': {
      console.log(`[Queue] audit_log: ${job.payload.action} by ${job.payload.userId}`)
      break
    }

    case 'snapshot_content': {
      console.log(`[Queue] snapshot_content triggered at ${job.payload.triggeredAt}`)
      break
    }

    case 'notify_batch_release': {
      console.log(`[Queue] notify_batch_release: ${job.payload.eventIds.length} events released`)
      break
    }

    case 'renew_forms_watch': {
      try {
        await gforms.renewWatch(job.payload.formId, job.payload.watchId)
        console.log(`[Queue] renew_forms_watch: renewed watch for form ${job.payload.formId}`)
      } catch (err) {
        console.error(`[Queue] renew_forms_watch failed for form ${job.payload.formId}:`, err)
      }
      break
    }
  }
}
