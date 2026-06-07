import { cors } from 'hono/cors'

import type { MiddlewareHandler } from 'hono'
import { createDb } from '../../db'
import { siteConfig } from '../../db/schema/site-config'
import { eq } from 'drizzle-orm'

async function getOriginsFromDb(env: {
  DB: import('@cloudflare/workers-types').D1Database
}): Promise<string[] | null> {
  try {
    const db = createDb(env.DB)
    const row = await db.query.siteConfig.findFirst({
      where: eq(siteConfig.key, 'allowed_origins')
    })
    if (row) return JSON.parse(row.value) as string[]
  } catch {
    /* D1 unavailable — fall through */
  }
  return null
}

export function createCorsMiddleware(
  allowedOrigins: string[]
): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')

    // Get dynamic allowed origins from KV if present, fallback to static list
    const dynamicOriginsJson = (await c.env.KV.get(
      'config:allowed_origins',
      'json'
    )) as string[] | null
    let currentAllowedOrigins = dynamicOriginsJson ?? allowedOrigins
    if (!dynamicOriginsJson) {
      const dbOrigins = await getOriginsFromDb(c.env)
      if (dbOrigins) {
        currentAllowedOrigins = dbOrigins
        await c.env.KV.put(
          'config:allowed_origins',
          JSON.stringify(dbOrigins),
          { expirationTtl: 86400 }
        )
      }
    }

    // Public Image Exemption: Allow any origin for images and skip strict checks.
    if (c.req.path.startsWith('/api/uploads')) {
      c.header('Access-Control-Allow-Origin', '*')
      c.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
      if (c.req.method === 'OPTIONS') {
        return c.body(null, 204)
      }
      return next()
    }

    // Strict ADR-001 Check: If an Origin is present, it MUST be allowed.
    if (
      !c.req.path.startsWith('/health') &&
      !c.req.path.startsWith('/api/auth') &&
      !c.req.path.startsWith('/internal') &&
      origin &&
      !currentAllowedOrigins.includes('*') &&
      !currentAllowedOrigins.includes(origin) &&
      origin !== new URL(c.req.url).origin
    ) {
      return c.json(
        {
          error: {
            code: 'DOMAIN_RESTRICTED',
            message: `Origin ${origin} is not allowed`
          }
        },
        403
      )
    }

    const honoCors = cors({
      origin: currentAllowedOrigins,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['ETag', 'Last-Modified', 'Cache-Control'],
      maxAge: 86400,
      credentials: true
    })

    return honoCors(c, next)
  }
}
