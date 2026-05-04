/**
 * Proof-of-Work Challenge Middleware (ADR-006, Layer 7).
 *
 * Anubis-inspired PoW challenge, implemented natively as Hono middleware.
 * Requires browsers to solve a SHA-256 PoW puzzle before accessing API endpoints.
 * After solving, a signed cookie is issued so subsequent requests bypass the challenge.
 *
 * Flow:
 *   1. Request arrives → no valid PoW cookie → serve challenge HTML page
 *   2. Browser runs JS PoW (find nonce where SHA-256(challengeId:nonce) meets difficulty)
 *   3. Client POSTs solution to /.well-known/leapify/pow/verify
 *   4. Server validates → sets signed cookie → redirects back to original URL
 *   5. Subsequent requests include cookie → pass through immediately
 *
 * Signing key: INTERNAL_API_SECRET (reused — same HMAC purpose as internal route auth)
 * Difficulty: POW_DIFFICULTY env var or DEFAULT_POW_DIFFICULTY (leading zero bits)
 */

import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import type { LeapifyBindings } from '../../types'

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Base path for PoW challenge routes */
export const POW_PATH = '/.well-known/leapify/pow'

/** Challenge verification endpoint */
export const POW_VERIFY_PATH = `${POW_PATH}/verify`

/** Cookie name for PoW auth token */
export const POW_COOKIE_NAME = 'leapify-pow'

/** KV key prefix for stored challenges */
const CHALLENGE_KV_PREFIX = 'pow:challenge:'

/** Default difficulty (leading zero bits required in SHA-256 hash) */
const DEFAULT_POW_DIFFICULTY = 4

/** Challenge expiration time in seconds */
const CHALLENGE_TTL_SEC = 120

/** Cookie expiration time in seconds (1 hour) */
const COOKIE_MAX_AGE_SEC = 3600

/** Paths exempt from PoW challenge */
const EXEMPT_PATHS = ['/health', '/internal', '/api/auth']

// ─── Base64url Utilities ────────────────────────────────────────────────────────

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

// ─── Crypto Helpers ─────────────────────────────────────────────────────────────

async function generateChallengeId(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return base64urlEncode(bytes)
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

    // Verify HMAC signature
    const key = await importHmacKey(secret)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      payloadBytes
    )
    if (!valid) return false

    // Parse payload: ip:ts:nonce
    const payload = new TextDecoder().decode(payloadBytes)
    const [cookieIp, tsStr] = payload.split(':')

    // Verify IP matches (prevent cookie sharing)
    if (cookieIp !== ip) return false

    // Verify not expired
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

function getDifficulty(env: LeapifyBindings): number {
  const raw = env.POW_DIFFICULTY
  if (!raw) return DEFAULT_POW_DIFFICULTY
  const parsed = parseInt(raw, 10)
  return isNaN(parsed)
    ? DEFAULT_POW_DIFFICULTY
    : Math.max(1, Math.min(parsed, 8))
}

// ─── Challenge Page HTML ────────────────────────────────────────────────────────

function challengePageHtml(
  challengeId: string,
  difficulty: number,
  originalUrl: string
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verifying your browser</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #f5f5f5; color: #333; }
    .card { background: #fff; border-radius: 12px; padding: 2rem; box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-align: center; max-width: 400px; }
    .spinner { width: 40px; height: 40px; border: 3px solid #e0e0e0; border-top-color: #333; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.9rem; color: #666; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Verifying your browser</h1>
    <p>This should only take a moment&hellip;</p>
  </div>
  <script>
    (async () => {
      const challengeId = ${JSON.stringify(challengeId)};
      const difficulty = ${difficulty};
      const prefix = '0'.repeat(Math.ceil(difficulty / 4));
      const data = new TextEncoder().encode(challengeId + ':');
      const buf = new ArrayBuffer(data.byteLength + 16);
      new Uint8Array(buf).set(data);
      const view = new DataView(buf);
      view.setUint32(data.length, 0);
      view.setUint32(data.length + 4, 0);
      view.setUint32(data.length + 8, 0);
      view.setUint32(data.length + 12, 0);
      let nonce = 0;
      const t0 = performance.now();
      while (true) {
        view.setUint32(data.length, nonce);
        const hash = await crypto.subtle.digest('SHA-256', buf);
        const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (hex.startsWith(prefix)) {
          const elapsed = performance.now() - t0;
          const res = await fetch(${JSON.stringify(POW_VERIFY_PATH)}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: challengeId, nonce, elapsed, redir: ${JSON.stringify(originalUrl)} }),
          });
          const data = await res.json();
          if (data.redirect) window.location.href = data.redirect;
          else window.location.reload();
          break;
        }
        nonce++;
      }
    })();
  </script>
</body>
</html>`
}

// ─── Verify Handler ─────────────────────────────────────────────────────────────

/**
 * POST /.well-known/leapify/pow/verify
 *
 * Validates a completed PoW challenge and issues a signed cookie.
 * Exported for mounting in app.ts.
 */
export async function handlePowVerify(
  c: Context<{ Bindings: LeapifyBindings }>
) {
  const body = await c.req.json<{
    id?: string
    nonce?: number
    elapsed?: number
    redir?: string
  }>()

  const { id, nonce, redir } = body

  if (!id || typeof nonce !== 'number') {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing challenge id or nonce'
        }
      },
      422
    )
  }

  // Retrieve challenge from KV
  const challenge = await c.env.KV.get(`${CHALLENGE_KV_PREFIX}${id}`)
  if (!challenge) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Challenge expired or invalid' } },
      404
    )
  }

  const { difficulty } = JSON.parse(challenge)

  // Verify PoW: SHA-256(challengeId:nonce) must have required leading zeros
  const input = new TextEncoder().encode(`${id}:${nonce}`)
  const hash = await crypto.subtle.digest('SHA-256', input)
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const requiredPrefix = '0'.repeat(Math.ceil(difficulty / 4))
  if (!hex.startsWith(requiredPrefix)) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid proof of work' } },
      422
    )
  }

  // Invalidate challenge (single-use)
  await c.env.KV.delete(`${CHALLENGE_KV_PREFIX}${id}`)

  // Issue signed cookie
  const secret = c.env.INTERNAL_API_SECRET
  const ip = getClientIp(c)
  const token = await signCookie(secret, ip)

  c.header(
    'Set-Cookie',
    `${POW_COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; Secure; HttpOnly; SameSite=Lax`
  )

  return c.json({ redirect: redir || '/' })
}

// ─── Main Middleware ─────────────────────────────────────────────────────────────

/**
 * PoW challenge middleware.
 *
 * Mount AFTER cors, BEFORE everything else:
 *   app.use('*', createCorsMiddleware(...))
 *   app.use('*', createPowChallengeMiddleware())  ← here
 *   app.use('*', createRefererGuard(...))
 */
export function createPowChallengeMiddleware() {
  return createMiddleware<{ Bindings: LeapifyBindings }>(async (c, next) => {
    // Always pass through the verify endpoint itself
    if (c.req.path === POW_VERIFY_PATH) return next()

    // Skip exempt paths (health, internal webhooks)
    if (EXEMPT_PATHS.some((p) => c.req.path.startsWith(p))) return next()

    // Skip if client has a valid Authorization header (Firebase JWT — auth middleware will handle)
    if (c.req.header('Authorization')) return next()

    // Check for valid PoW cookie
    const cookieHeader = c.req.header('Cookie') ?? ''
    const cookieMatch = cookieHeader.match(
      new RegExp(`${POW_COOKIE_NAME}=([^;]+)`)
    )
    if (cookieMatch) {
      const secret = c.env.INTERNAL_API_SECRET
      const ip = getClientIp(c)
      const valid = await validateCookie(secret, cookieMatch[1], ip)
      if (valid) return next()
    }

    // ── Issue challenge ──────────────────────────────────────────────────────

    const difficulty = getDifficulty(c.env)
    const challengeId = await generateChallengeId()

    // Store challenge in KV with TTL
    await c.env.KV.put(
      `${CHALLENGE_KV_PREFIX}${challengeId}`,
      JSON.stringify({ difficulty, createdAt: Date.now() }),
      { expirationTtl: CHALLENGE_TTL_SEC }
    )

    // Serve challenge page
    const originalUrl = c.req.path + (c.req.query('?') ? c.req.query('?') : '')
    const html = challengePageHtml(challengeId, difficulty, originalUrl)

    return c.html(html, 200)
  })
}
