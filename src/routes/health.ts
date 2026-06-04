import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { LeapifyEnv } from '../types'
import { authMiddleware, adminMiddleware } from '../auth/middleware'

export const healthRoute = new Hono<LeapifyEnv>()

// ─── Individual service probes ──────────────────────────────────────────────

interface ServiceHealth {
  configured: boolean
  ok: boolean
  latencyMs: number
  error?: string
}

async function probeResend(apiKey: string): Promise<ServiceHealth> {
  const start = Date.now()
  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    return {
      configured: true,
      ok: res.ok,
      latencyMs: Date.now() - start,
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    }
  } catch (e) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - start,
      error: String(e),
    }
  }
}

async function probeSes(
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<ServiceHealth> {
  // SES v2 has no lightweight "ping" endpoint. Verify credentials are
  // configured and the region is valid by checking the env vars.
  const start = Date.now()
  try {
    if (!region || !accessKeyId || !secretAccessKey) {
      return {
        configured: false,
        ok: false,
        latencyMs: Date.now() - start,
        error: 'Missing SES credentials',
      }
    }
    return {
      configured: true,
      ok: true,
      latencyMs: Date.now() - start,
    }
  } catch (e) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - start,
      error: String(e),
    }
  }
}

async function probeGForms(
  serviceAccountJson: string,
): Promise<ServiceHealth> {
  const start = Date.now()
  try {
    const creds = JSON.parse(serviceAccountJson) as {
      client_email: string
      private_key: string
    }

    // Try to get an OAuth2 token — verifies the SA key is valid
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/forms.responses.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }

    const header = { alg: 'RS256', typ: 'JWT' }
    const encode = (obj: unknown) =>
      btoa(JSON.stringify(obj))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')

    const signingInput = `${encode(header)}.${encode(claims)}`

    const pemBody = creds.private_key
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\s/g, '')

    const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0))
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      keyBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      new TextEncoder().encode(signingInput),
    )

    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')

    const jwt = `${signingInput}.${sigB64}`

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    })

    return {
      configured: true,
      ok: res.ok,
      latencyMs: Date.now() - start,
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    }
  } catch (e) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - start,
      error: String(e),
    }
  }
}

// ─── Route ──────────────────────────────────────────────────────────────────

/**
 * GET /health
 *
 * Publicly accessible — no CORS, no auth, no PoW.
 * Runs lightweight probes against each configured external service.
 *
 * Response:
 *   {
 *     status: 'ok' | 'degraded',
 *     timestamp: string,
 *     services: {
 *       ses:       { configured, ok, latencyMs, error? },
 *       resend:    { configured, ok, latencyMs, error? },
 *       gforms:    { configured, ok, latencyMs, error? },
 *     }
 *   }
 */
healthRoute.get(
  '/',
  describeRoute({
    tags: ['Health'],
    summary: 'Service health check',
    responses: { 200: { description: 'Health status of configured services' } },
  }),
  async (c) => {
  const env = c.env

  const hasSes = Boolean(env.SES_REGION) && Boolean(env.SES_ACCESS_KEY_ID) && Boolean(env.SES_SECRET_ACCESS_KEY)
  const hasResend = Boolean(env.RESEND_API_KEY)
  let hasGForms = false
  if (env.GFORMS_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(env.GFORMS_SERVICE_ACCOUNT_JSON)
      hasGForms = Boolean(parsed.client_email && parsed.private_key)
    } catch {
      /* invalid JSON — not configured */
    }
  }

  const probes: Promise<[string, ServiceHealth]>[] = []

  if (hasSes) {
    probes.push(
      probeSes(env.SES_REGION!, env.SES_ACCESS_KEY_ID!, env.SES_SECRET_ACCESS_KEY!).then(
        (h) => ['ses', h] as const,
      ),
    )
  }
  if (hasResend) {
    probes.push(
      probeResend(env.RESEND_API_KEY!).then((h) => ['resend', h] as const),
    )
  }
  if (hasGForms) {
    probes.push(
      probeGForms(env.GFORMS_SERVICE_ACCOUNT_JSON!).then(
        (h) => ['gforms', h] as const,
      ),
    )
  }

  const results = await Promise.all(probes)

  const services: Record<string, ServiceHealth> = {}
  for (const [name, health] of results) {
    services[name] = health
  }

  // If no services are configured, still report ok
  const allOk = results.length === 0 || results.every(([, h]) => h.ok)

  return c.json({
    data: {
      status: allOk ? 'OK' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      services,
    },
  })
})

// ─── Queue burst (internal) ─────────────────────────────────────────────────

/**
 * POST /health/queue-burst
 * Internal load testing endpoint that blasts 100 mock items into the queue.
 */
healthRoute.post(
  '/queue-burst',
  describeRoute({
    tags: ['Health'],
    summary: 'Queue load test (admin)',
    responses: { 200: { description: 'Items queued' } },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  if (!c.env.EMAIL_QUEUE) {
    return c.json({ error: 'Queue binding missing' }, 400)
  }

  const batch = Array.from({ length: 100 }, (_, i) => ({
    body: {
      type: 'audit_log',
      payload: {
        action: 'queue_load_test',
        userId: 'system',
        meta: { index: i, time: Date.now() },
      },
    },
  }))

  await (c.env.EMAIL_QUEUE as any).sendBatch(batch)

  return c.json({ status: 'queued', count: 100 })
})
