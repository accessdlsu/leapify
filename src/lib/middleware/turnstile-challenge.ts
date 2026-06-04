import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import type { LeapifyBindings } from '../../types'

export const TURNSTILE_PATH = '/.well-known/leapify/turnstile'

export const TURNSTILE_VERIFY_PATH = `${TURNSTILE_PATH}/verify`

export const TURNSTILE_COOKIE_NAME = 'leapify-turnstile'

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

const COOKIE_MAX_AGE_SEC = 86400

const EXEMPT_PATHS = [
  "/health",
  "/internal",
  "/api/auth",
  "/api/uploads/images",
  "/api/classes",
  "/api/faqs",
  "/api/config",
  "/api/themes",
  "/api/organizations",
  "/api/docs",
  "/api/openapi.json",
  TURNSTILE_VERIFY_PATH,
];

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

async function signCookie(secret: string, ip: string): Promise<string> {
  const ts = Date.now()
  const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(8)))
  const payload = `${ip}:${ts}:${nonce}`
  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload)
  )
  const sigB64 = base64urlEncode(new Uint8Array(sig))
  return `${base64urlEncode(new TextEncoder().encode(payload))}.${sigB64}`
}

async function validateCookie(
  secret: string,
  cookie: string,
  ip: string
): Promise<boolean> {
  try {
    const [payloadB64, sigB64] = cookie.split('.')
    if (!payloadB64 || !sigB64) return false

    const payloadBytes = base64urlDecode(payloadB64)
    const sigBytes = base64urlDecode(sigB64)

    const key = await importHmacKey(secret)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      payloadBytes
    )
    if (!valid) return false

    const payload = new TextDecoder().decode(payloadBytes)
    const [cookieIp, tsStr] = payload.split(':')

    if (cookieIp !== ip) return false

    const ts = parseInt(tsStr, 10)
    if (isNaN(ts) || Date.now() - ts > COOKIE_MAX_AGE_SEC * 1000) return false

    return true
  } catch {
    return false
  }
}

function getClientIp(c: Context<{ Bindings: LeapifyBindings }>): string {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Real-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

function isExempt(path: string): boolean {
  const normalized = path.toLowerCase().replace(/\/$/, '')
  return EXEMPT_PATHS.some((p) => {
    const ep = p.toLowerCase().replace(/\/$/, '')
    return normalized === ep || normalized.startsWith(ep + '/')
  })
}

function setCookieHeader(c: Context<{ Bindings: LeapifyBindings }>, token: string): void {
  const isSecure = c.req.raw.url.startsWith("https") || c.req.header("x-forwarded-proto") === "https";
  c.header(
    "Set-Cookie",
    `${TURNSTILE_COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; ${
      isSecure ? "Secure; " : ""
    }HttpOnly; SameSite=Lax`,
  );
}

/**
 * POST /.well-known/leapify/turnstile/verify
 *
 * Validates a Turnstile token and issues a signed cookie on success.
 */
export async function handleTurnstileVerify(
  c: Context<{ Bindings: LeapifyBindings }>
) {
  const body = await c.req.json<{ token?: string }>()
  const { token } = body

  if (!token) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Missing Turnstile token' } },
      422
    )
  }

  const secret = c.env.TURNSTILE_SECRET_KEY
  if (!secret) {
    return c.json(
      { error: { code: 'CONFIG_ERROR', message: 'Turnstile not configured' } },
      500
    )
  }

  const ip = getClientIp(c)
  const formData = new URLSearchParams()
  formData.append('secret', secret)
  formData.append('response', token)
  if (ip !== 'unknown') {
    formData.append('remoteip', ip)
  }

  const res = await fetch(VERIFY_URL, {
    method: 'POST',
    body: formData,
  })
  const outcome = await res.json() as { success: boolean; 'error-codes'?: string[] }

  if (!outcome.success) {
    return c.json(
      { error: { code: 'TURNSTILE_FAILED', message: 'Turnstile verification failed', details: outcome['error-codes'] } },
      403
    )
  }

  const cookieToken = await signCookie(secret, ip)
  setCookieHeader(c, cookieToken)

  return c.json({ success: true })
}

/**
 * Turnstile challenge middleware.
 *
 * Requires a valid Turnstile-signed cookie on all non-exempt requests.
 * The client must first solve a Turnstile challenge and POST the token
 * to the verify endpoint to obtain the cookie.
 *
 * Exempt paths: /health, /internal, /api/auth, /api/uploads/images,
 * and the verify endpoint itself.
 */
export function createTurnstileMiddleware() {
  return createMiddleware<{ Bindings: LeapifyBindings }>(async (c, next) => {
    if (isExempt(c.req.path)) return next()

    if (c.req.method === 'OPTIONS') return next()

    // Skip challenge for authenticated requests (Bearer token present)
    // The auth middleware will handle session validation instead.
    if (c.req.header('Authorization')) return next()

    const secret = c.env.TURNSTILE_SECRET_KEY
    if (!secret) return next()

    const cookieHeader = c.req.header('Cookie') ?? ''
    const cookieMatch = cookieHeader.match(
      new RegExp(`${TURNSTILE_COOKIE_NAME}=([^;]+)`)
    )
    if (cookieMatch) {
      const ip = getClientIp(c)
      const valid = await validateCookie(secret, cookieMatch[1], ip)
      if (valid) return next()
    }

    return c.json(
      { error: { code: 'TURNSTILE_REQUIRED', message: 'Turnstile verification required' } },
      401
    )
  })
}
