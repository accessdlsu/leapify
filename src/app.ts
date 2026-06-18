import { Hono } from 'hono'
import { openAPIRouteHandler } from 'hono-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import type { LeapifyEnv } from './types'

declare const __APP_VERSION__: string
import { errorHandler } from './lib/middleware/error-handler'
import { createCorsMiddleware } from './lib/middleware/cors'
import { createRefererGuard } from './lib/middleware/referer-guard'
import {
  createTurnstileMiddleware,
  handleTurnstileVerify,
  TURNSTILE_VERIFY_PATH,
} from './lib/middleware/turnstile-challenge'
import { serviceUnavailable } from './lib/errors'
import { resolveAllowedOrigins } from './lib/resolve-origins'
import { createAuth } from './auth/auth'
import { authMiddleware, adminMiddleware } from './auth/middleware'
import { healthRoute } from './routes/health'
import { classesRoute } from './routes/classes'
import { usersRoute } from './routes/users'
import { siteConfigRoute } from './routes/site-config'
import { faqsRoute } from './routes/faqs'
import { gformsWebhookRoute } from './routes/internal/gforms-webhook'
import { reconcileSlotsRoute } from './routes/internal/reconcile-slots'
import { batchReleaseRoute } from './routes/internal/batch-release'
import { reminderEmailsRoute } from './routes/internal/reminder-emails'
import { renewWatchesRoute } from './routes/internal/renew-watches'
import { uploadsRoute } from './routes/uploads'
import { themesRoute } from './routes/themes'
import { organizationsRoute } from './routes/organizations'
import { emailRoute } from './routes/email'

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
  app.use('*', createTurnstileMiddleware())
  app.use('*', createRefererGuard(options.allowedOrigins ?? ['*']))

  // Better Auth HTTP handler — OAuth redirects, callbacks, session, token endpoints.
  // Mounted BEFORE the maintenance check so auth is always reachable.
  app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
    const resolvedOrigins = await resolveAllowedOrigins(
      c.env,
      options.allowedOrigins ?? ['*'],
    )
    const auth = createAuth(c.env, resolvedOrigins)

    // Ensure cf-connecting-ip is present for Better Auth rate limiting
    const req = c.req.raw
    if (!req.headers.get('cf-connecting-ip')) {
      const forwarded = req.headers.get('x-forwarded-for')
      const ip = forwarded?.split(',')[0]?.trim() || '127.0.0.1'
      const newHeaders = new Headers(req.headers)
      newHeaders.set('cf-connecting-ip', ip)
      return auth.handler(new Request(req.url, {
        method: req.method,
        headers: newHeaders,
        body: (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') ? null : req.body,
        redirect: req.redirect,
      }))
    }

    return auth.handler(req)
  })

  // Maintenance mode check
  app.use('*', async (c, next) => {
    // Skip for health, auth, uploads (public images), and internal routes so
    // operators / frontend-proxied image requests can still get through.
    if (
      c.req.path === '/health' ||
      c.req.path.startsWith('/api/auth') ||
      c.req.path.startsWith('/api/uploads') ||
      c.req.path.startsWith('/internal')
    ) {
      return next()
    }
    // Read maintenance_mode flag from KV (set via PATCH /config/maintenance_mode).
    // KV is faster than D1 for this hot-path check — O(1) per request.
    const flag = await c.env.KV.get<boolean>('config:maintenance_mode', 'json')
    if (flag === true) {
      // Allow authenticated requests through so console admins can manage the site.
      // The auth middleware on each route still validates the token.
      const hasAuth =
        !!c.req.header('Authorization') ||
        c.req.header('Cookie')?.includes('better-auth.session_token=')
      if (!hasAuth) {
        throw serviceUnavailable(
          'The site is currently under maintenance. Please check back soon.',
        )
      }
    }
    return next()
  })

  // Routes
  app.post(TURNSTILE_VERIFY_PATH, handleTurnstileVerify)
  app.route('/health', healthRoute)
  app.route('/api/config', siteConfigRoute)
  app.route('/api/classes', classesRoute)
  app.route('/api/themes', themesRoute)
  app.route('/api/users', usersRoute)
  app.route('/api/organizations', organizationsRoute)
  app.route('/api/faqs', faqsRoute)
  app.route('/api/email', emailRoute)
  app.route('/api/uploads', uploadsRoute)
  app.route('/internal/gforms-webhook', gformsWebhookRoute)
  app.route('/internal/reconcile-slots', reconcileSlotsRoute)
  app.route('/internal/batch-release', batchReleaseRoute)
  app.route('/internal/reminder-emails', reminderEmailsRoute)
  app.route('/internal/renew-watches', renewWatchesRoute)

  // OpenAPI docs — admin only
  app.get(
    '/api/openapi.json',
    authMiddleware,
    adminMiddleware,
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: 'Leapify API',
          version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
          description: 'DLSU CSO LEAP backend API',
        },
        openapi: '3.1.0',
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              description: 'Value of the better-auth.session_token cookie (extract from DevTools → Application → Cookies)',
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    }),
  )

  app.get(
    '/api/docs',
    authMiddleware,
    adminMiddleware,
    swaggerUI({ url: '/api/openapi.json' }),
  )

  // Error handler
  app.onError(errorHandler)

  // 404
  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404),
  )

  return app
}
