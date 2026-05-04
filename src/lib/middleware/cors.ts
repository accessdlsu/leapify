import { cors } from 'hono/cors'

import type { MiddlewareHandler } from 'hono'

export function createCorsMiddleware(allowedOrigins: string[]): MiddlewareHandler {
  const honoCors = cors({
    origin: allowedOrigins,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['ETag', 'Last-Modified', 'Cache-Control'],
    maxAge: 86400,
    credentials: true,
  })

  return async (c, next) => {
    const origin = c.req.header('origin')
    
    // Strict ADR-001 Check: If an Origin is present, it MUST be allowed.
    // /health, /api/auth, and /internal are exempt so uptime monitors,
    // OAuth redirects, and internal webhooks can reach them from any origin.
    if (
      !c.req.path.startsWith('/health') &&
      !c.req.path.startsWith('/api/auth') &&
      !c.req.path.startsWith('/internal') &&
      origin && 
      !allowedOrigins.includes('*') && 
      !allowedOrigins.includes(origin)
    ) {
      return c.json(
        { error: { code: 'DOMAIN_RESTRICTED', message: `Origin ${origin} is not allowed` } },
        403
      )
    }

    return honoCors(c, next)
  }
}
