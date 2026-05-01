import { eq } from 'drizzle-orm'
import type { LeapifyBindings } from '../types'
import type { LeapifyJob } from './jobs'
import { createDb } from '../db'
import { events } from '../db/schema/events'
import { createEmailRouter, type EmailRouter } from '../services/email'
import { buildReminderEmail } from '../services/resend'
import { GFormsService } from '../services/gforms'
import { ContentfulManagement } from '../services/contentful-management'
import { ensureContentTypes, pushToContentful } from '../services/snapshot'

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
  const { db, email, gforms, env } = services

  switch (job.type) {
    case 'send_email': {
      if (!email) throw new Error('Email provider not configured (SES credentials missing)')
      const result = await email.sendEmail(job.payload)
      console.log(`[Queue] send_email dispatched via ${result.provider} (id=${result.id})`)
      break
    }

    case 'send_reminder_email': {
      if (!email) throw new Error('Email provider not configured (SES credentials missing)')

      const event = await db.query.events.findFirst({
        where: eq(events.id, job.payload.eventId),
      })
      if (!event?.gformsId) break

      const emails = await gforms.getRespondentEmails(event.gformsId)
      if (emails.length === 0) break

      const isDay = job.payload.hoursBeforeEvent === 24
      const subject = isDay
        ? `Reminder: "${event.title}" is tomorrow!`
        : `Reminder: "${event.title}" starts in 1 hour!`

      const html = buildReminderEmail(event)

      // Send in batches of 100; per-message fallback applies inside sendEmail()
      const BATCH_SIZE = 100
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const chunk = emails.slice(i, i + BATCH_SIZE).map((to) => ({ to, subject, html }))
        const results = await email.sendBatch(chunk)

        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (failures.length > 0) {
          console.error(
            `[Queue] send_reminder_email: ${failures.length}/${chunk.length} messages failed in batch ${i / BATCH_SIZE + 1}`,
            failures.map((f) => f.reason),
          )
        }
      }

      // Mark reminder as sent
      if (isDay) {
        await db
          .update(events)
          .set({ reminder24hSent: true })
          .where(eq(events.id, job.payload.eventId))
      } else {
        await db
          .update(events)
          .set({ reminder1hSent: true })
          .where(eq(events.id, job.payload.eventId))
      }
      break
    }

    case 'audit_log': {
      console.log('[Audit]', job.payload.action, job.payload.userId, job.payload.meta)
      break
    }

    case 'notify_batch_release': {
      console.log('[Release] Events published:', job.payload.eventIds.join(', '))
      break
    }

    case 'renew_forms_watch': {
      const renewed = await gforms.renewWatch(job.payload.formId, job.payload.watchId)
      const newExpiry = Math.floor(new Date(renewed.expireTime).getTime() / 1000)
      await db
        .update(events)
        .set({ watchExpiresAt: newExpiry })
        .where(eq(events.gformsId, job.payload.formId))
      break
    }

    case 'snapshot_content': {
      console.log('[Snapshot] Content snapshot triggered at', job.payload.triggeredAt)

      if (!ContentfulManagement.isConfigured(env.CONTENTFUL_SPACE_ID, env.CONTENTFUL_MANAGEMENT_TOKEN)) {
        console.warn('[Snapshot] Contentful Management API credentials not configured — skipping')
        break
      }

      const mgmt = new ContentfulManagement(
        env.CONTENTFUL_SPACE_ID!,
        env.CONTENTFUL_MANAGEMENT_TOKEN!,
        env.CONTENTFUL_ENVIRONMENT,
      )

      // Auto-generate content types, then push D1 → Contentful
      await ensureContentTypes(mgmt, {})
      const result = await pushToContentful(db, mgmt, {})
      console.log('[Snapshot] Result:', JSON.stringify(result))
      break
    }
  }
}
