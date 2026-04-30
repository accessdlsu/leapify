import { Hono } from 'hono'
import type { LeapifyEnv } from './types'
import { errorHandler } from './lib/middleware/error-handler'
import { createCorsMiddleware } from './lib/middleware/cors'
import { createRefererGuard } from './lib/middleware/referer-guard'
import {
  createPowChallengeMiddleware,
  handlePowVerify,
  POW_VERIFY_PATH,
} from './lib/middleware/pow-challenge'
import { serviceUnavailable } from './lib/errors'
import { createAuth } from './auth/auth'
import { healthRoute } from './routes/health'
import { eventsRoute } from './routes/events'
import { usersRoute } from './routes/users'
import { siteConfigRoute } from './routes/site-config'
import { faqsRoute } from './routes/faqs'
import { gformsWebhookRoute } from './routes/internal/gforms-webhook'

export interface LeapifyAppOptions {
  allowedOrigins?: string[]
  /**
   * Public HTTPS URL of your Cloudflare Worker.
   * Required for Google Forms Watch push notifications to work.
   * Google will POST to {gformsWebhookUrl}/internal/gforms-webhook on each new submission.
   *
   * @example 'https://leap.yourdomain.com'
   */
  gformsWebhookUrl?: string
}

export function createApp(options: LeapifyAppOptions = {}): Hono<LeapifyEnv> {
  const app = new Hono<LeapifyEnv>()

  // Expose gformsWebhookUrl to routes via app-level middleware
  if (options.gformsWebhookUrl) {
    const webhookUrl = `${options.gformsWebhookUrl.replace(/\/$/, '')}/internal/gforms-webhook`
    app.use('*', async (c, next) => {
      c.set('gformsWebhookUrl', webhookUrl)
      return next()
    })
  }

  // Global middleware
  app.use('*', createCorsMiddleware(options.allowedOrigins ?? ['*']))
  app.use('*', createPowChallengeMiddleware())
  app.use('*', createRefererGuard(options.allowedOrigins ?? ['*']))

  // Better Auth HTTP handler — OAuth redirects, callbacks, session, token endpoints.
  // Mounted BEFORE the maintenance check so auth is always reachable.
  app.on(['POST', 'GET'], '/api/auth/*', (c) => {
    const auth = createAuth(c.env)
    return auth.handler(c.req.raw)
  })

  // Maintenance mode check
  app.use('*', async (c, next) => {
    // Skip for health, auth, and internal routes so operators can still access them
    if (
      c.req.path === '/health' ||
      c.req.path.startsWith('/api/auth') ||
      c.req.path.startsWith('/internal')
    ) {
      return next()
    }
    // Read maintenance_mode flag from KV (set via PATCH /config/maintenance_mode).
    // KV is faster than D1 for this hot-path check — O(1) per request.
    const flag = await c.env.KV.get<boolean>('config:maintenance_mode', 'json')
    if (flag === true) {
      throw serviceUnavailable(
        'The site is currently under maintenance. Please check back soon.',
      )
    }
    return next()
  })

  // Routes
  app.post(POW_VERIFY_PATH, handlePowVerify)
  app.route('/health', healthRoute)
  app.route('/config', siteConfigRoute)
  app.route('/events', eventsRoute)
  app.route('/users', usersRoute)
  app.route('/faqs', faqsRoute)
  app.route('/internal/gforms-webhook', gformsWebhookRoute)

  // Error handler
  app.onError(errorHandler)

  // 404
  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404),
  )

  return app
}
