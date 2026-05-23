import { cors } from 'hono/cors'

import type { MiddlewareHandler } from 'hono'

export function createCorsMiddleware(allowedOrigins: string[]): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");

    // Get dynamic allowed origins from KV if present, fallback to static list
    const dynamicOriginsJson = (await c.env.KV.get('config:allowed_origins', 'json')) as string[] | null
    const currentAllowedOrigins = dynamicOriginsJson ?? allowedOrigins

    // Public Image Exemption: Allow any origin for images and skip strict checks.
    if (c.req.path.startsWith("/api/uploads/images")) {
      c.header("Access-Control-Allow-Origin", "*");
      c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
      if (c.req.method === "OPTIONS") {
        return c.body(null, 204);
      }
      return next();
    }

    // Strict ADR-001 Check: If an Origin is present, it MUST be allowed.
    if (
      !c.req.path.startsWith("/health") &&
      !c.req.path.startsWith("/api/auth") &&
      !c.req.path.startsWith("/internal") &&
      origin &&
      !currentAllowedOrigins.includes("*") &&
      !currentAllowedOrigins.includes(origin)
    ) {
      return c.json(
        {
          error: {
            code: "DOMAIN_RESTRICTED",
            message: `Origin ${origin} is not allowed`,
          },
        },
        403,
      );
    }

    const honoCors = cors({
      origin: currentAllowedOrigins,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['ETag', 'Last-Modified', 'Cache-Control'],
      maxAge: 86400,
      credentials: true,
    })

    return honoCors(c, next);
  };
}
