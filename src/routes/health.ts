import { Hono } from 'hono'
import type { LeapifyEnv } from '../types'

export const healthRoute = new Hono<LeapifyEnv>()

/**
 * GET /health
 *
 * Publicly accessible — no CORS restriction, no auth.
 * Used by uptime monitors, load balancers, and CF Health Checks.
 *
 * Response shape:
 *   { status: 'ok', timestamp: string, providers: { ses: boolean, resend: boolean } }
 *
 * `providers` reflects which email providers are configured in this Worker
 * so operators can confirm secrets were set correctly after deploy.
 */
healthRoute.get('/', (c) => {
  const hasSes =
    Boolean(c.env.SES_REGION) &&
    Boolean(c.env.SES_ACCESS_KEY_ID) &&
    Boolean(c.env.SES_SECRET_ACCESS_KEY)

  const hasResend = Boolean(c.env.RESEND_API_KEY)

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    providers: {
      ses: hasSes,
      resend: hasResend,
    },
  })
})

/**
 * POST /health/queue-burst
 * Internal load testing endpoint that blasts 100 mock items into the queue.
 */
healthRoute.post('/queue-burst', async (c) => {
  if (!c.env.EMAIL_QUEUE) {
    return c.json({ error: "Queue binding missing" }, 400);
  }

  // Cloudflare Queue sendBatch takes a maximum of 100 messages at a time.
  // We use the 'audit_log' job type so it mocks everything instantly and 
  // avoids touching the physical SES email limits entirely!
  const batch = Array.from({ length: 100 }, (_, i) => ({
    body: {
      type: "audit_log",
      payload: {
        action: "queue_load_test",
        userId: "system",
        meta: { index: i, time: Date.now() }
      }
    }
  }));

  // Typecast safely for Hono CF bindings
  await (c.env.EMAIL_QUEUE as any).sendBatch(batch);

  return c.json({ status: "queued", count: 100 });
});
