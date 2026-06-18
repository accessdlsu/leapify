import { Hono } from 'hono'
import { validator, describeRoute } from 'hono-openapi'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { events } from '../db/schema/classes'
import { createEmailRouter } from '../services/email'
import { buildReminderEmail } from '../services/resend'
import { GFormsService } from '../services/gforms'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { badRequest, notFound, serviceUnavailable } from '../lib/errors'

export const emailRoute = new Hono<LeapifyEnv>()

const testEmailSchema = z.object({
  to: z.string().email(),
})

const customEmailSchema = z.object({
  subject: z.string().min(1).max(200),
  html: z.string().min(1).max(50000),
})

// POST /api/email/test — admin only, send a test email
emailRoute.post(
  '/test',
  describeRoute({
    tags: ['Email'],
    summary: 'Send test email',
    description: 'Sends a test email to verify email configuration.',
    responses: {
      200: { description: 'Test email sent successfully' },
      503: { description: 'Email providers not configured' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  validator('json', testEmailSchema),
  async (c) => {
    const { to } = c.req.valid('json')
    const email = createEmailRouter(c.env)

    if (!email) {
      throw serviceUnavailable('No email providers (SES or Resend) are configured.')
    }

    const result = await email.sendEmail({
      to,
      subject: 'Leapify Email Test',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #1a1a2e;">✅ Email Test Successful</h2>
          <p>This is a test email from Leapify. Your email configuration is working correctly.</p>
          <p style="margin-top: 24px; font-size: 12px; color: #999;">
            DLSU CSO LEAP — Sent at ${new Date().toISOString()}
          </p>
        </div>
      `,
    })

    return c.json({ data: { provider: result.provider, id: result.id } })
  },
)

// POST /api/email/:slug/send-reminders — admin only, manually trigger reminders
emailRoute.post(
  '/:slug/send-reminders',
  describeRoute({
    tags: ['Email'],
    summary: 'Send event reminders manually',
    description: 'Triggers reminder emails for a specific event. Fetches registrants from Google Forms and sends in batches.',
    responses: {
      202: { description: 'Reminder emails queued' },
      400: { description: 'No gformsId set' },
      404: { description: 'Event not found' },
      503: { description: 'Email providers not configured' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const { slug } = c.req.param()
    const db = createDb(c.env.DB)
    const email = createEmailRouter(c.env)

    if (!email) {
      throw serviceUnavailable('No email providers (SES or Resend) are configured.')
    }

    const event = await db.query.events.findFirst({
      where: eq(events.slug, slug),
      with: { organization: true },
    })
    if (!event) throw notFound('Event')
    if (!event.gformsId) throw badRequest('No Google Forms ID set for this event')

    const gforms = new GFormsService(c.env.GFORMS_SERVICE_ACCOUNT_JSON)
    const emails = await gforms.getRespondentEmails(event.gformsId)

    if (emails.length === 0) {
      return c.json({ data: { sent: 0, message: 'No registrants found' } })
    }

    const subject = `Reminder: "${event.title}" is coming up!`
    const html = buildReminderEmail({
      title: event.title,
      organization: event.organization?.name ?? null,
      dateTime: event.dateTime,
      startTime: event.startTime,
      venue: event.venue,
      gformsUrl: event.gformsUrl,
    })

    // Queue emails in batches of 50 via the EMAIL_QUEUE
    const BATCH_SIZE = 50
    let queued = 0
    if (c.env.EMAIL_QUEUE) {
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const chunk = emails.slice(i, i + BATCH_SIZE)
        await c.env.EMAIL_QUEUE.send({
          type: 'send_email',
          payload: { to: chunk, subject, html },
        })
        queued += chunk.length
      }
    } else {
      // Fallback: send directly if no queue configured
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const chunk = emails.slice(i, i + BATCH_SIZE)
        await email.sendEmail({ to: chunk, subject, html })
        queued += chunk.length
      }
    }

    return c.json({ data: { sent: queued, total: emails.length } }, 202)
  },
)

// POST /api/email/:slug/send — admin only, send custom email to registrants
emailRoute.post(
  '/:slug/send',
  describeRoute({
    tags: ['Email'],
    summary: 'Send custom email to event registrants',
    description: 'Sends a custom email to all registrants of a specific event.',
    responses: {
      202: { description: 'Emails queued' },
      400: { description: 'No gformsId set' },
      404: { description: 'Event not found' },
      503: { description: 'Email providers not configured' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  validator('json', customEmailSchema),
  async (c) => {
    const { slug } = c.req.param()
    const { subject, html } = c.req.valid('json')
    const db = createDb(c.env.DB)
    const email = createEmailRouter(c.env)

    if (!email) {
      throw serviceUnavailable('No email providers (SES or Resend) are configured.')
    }

    const event = await db.query.events.findFirst({
      where: eq(events.slug, slug),
      columns: { id: true, title: true, gformsId: true },
    })
    if (!event) throw notFound('Event')
    if (!event.gformsId) throw badRequest('No Google Forms ID set for this event')

    const gforms = new GFormsService(c.env.GFORMS_SERVICE_ACCOUNT_JSON)
    const emails = await gforms.getRespondentEmails(event.gformsId)

    if (emails.length === 0) {
      return c.json({ data: { sent: 0, message: 'No registrants found' } })
    }

    // Queue emails in batches of 50
    const BATCH_SIZE = 50
    let queued = 0
    if (c.env.EMAIL_QUEUE) {
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const chunk = emails.slice(i, i + BATCH_SIZE)
        await c.env.EMAIL_QUEUE.send({
          type: 'send_email',
          payload: { to: chunk, subject, html },
        })
        queued += chunk.length
      }
    } else {
      // Fallback: send directly if no queue configured
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const chunk = emails.slice(i, i + BATCH_SIZE)
        await email.sendEmail({ to: chunk, subject, html })
        queued += chunk.length
      }
    }

    return c.json({ data: { sent: queued, total: emails.length } }, 202)
  },
)
