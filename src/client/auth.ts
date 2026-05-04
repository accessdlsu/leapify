/**
 * Better Auth client helper for Leapify API consumers.
 *
 * This module is **browser-safe** — no Cloudflare, Drizzle, or Hono deps.
 * It wraps Better Auth's client SDK with the bearer plugin so that tokens
 * can be stored and retrieved as plain strings (no cookie dependency on
 * the consumer's frontend).
 *
 * @example
 * // lib/auth.ts (frontend)
 * import { createLeapifyAuthClient, signInWithGoogleRedirect } from 'leapify/client'
 *
 * export const authClient = createLeapifyAuthClient(process.env.NEXT_PUBLIC_API_URL!)
 *
 * // Redirect-based Google sign-in:
 * await signInWithGoogleRedirect(authClient, '/dashboard')
 */

import { createAuthClient } from 'better-auth/client'

const AUTH_TOKEN_KEY = 'better-auth.session_token'

/**
 * Create a Better Auth client bound to the Leapify Worker URL.
 *
 * It uses the 'Bearer' auth type to send the stored session token
 * in the Authorization header.
 */
export function createLeapifyAuthClient(baseUrl: string) {
  return createAuthClient({
    baseURL: baseUrl,
    fetchOptions: {
      auth: {
        type: 'Bearer',
        token: () => {
          if (typeof window !== 'undefined') {
            return localStorage.getItem(AUTH_TOKEN_KEY) || ''
          }
          return ''
        }
      }
    }
  })
}

export type LeapifyAuthClient = ReturnType<typeof createLeapifyAuthClient>

/**
 * Sign in with Google via OAuth redirect flow.
 *
 * Redirects the browser to Google's OAuth page. After authentication,
 * Google redirects back to the Better Auth callback endpoint, which
 * creates a session and redirects to `callbackURL`.
 *
 * Call `syncCookieSessionToStorage()` on app init to restore the
 * session from the cookie after a redirect-based sign-in.
 *
 * @param authClient - Client created by createLeapifyAuthClient
 * @param callbackURL - Path or URL to redirect to after successful auth (e.g. '/dashboard')
 *
 * @example
 * import { signInWithGoogleRedirect } from 'leapify/client'
 *
 * document.getElementById('google-btn').onclick = () => {
 *   signInWithGoogleRedirect(authClient, '/dashboard')
 * }
 */
export async function signInWithGoogleRedirect(
  authClient: LeapifyAuthClient,
  callbackURL: string,
): Promise<void> {
  await authClient.signIn.social({
    provider: 'google',
    callbackURL,
  })
}

/**
 * Sync a cookie-based Better Auth session into localStorage.
 *
 * After an OAuth redirect flow, Better Auth stores the session in an
 * HTTP-only cookie. This function reads that session via `getSession()`
 * and stores the token in localStorage so that subsequent API calls
 * using the Bearer token work correctly.
 *
 * Call this once on app initialization, before `initializeSession()`.
 *
 * @param authClient - Client created by createLeapifyAuthClient
 *
 * @example
 * import { syncCookieSessionToStorage, initializeSession } from 'leapify/client'
 *
 * // On app mount:
 * await syncCookieSessionToStorage(authClient)
 * const user = await initializeSession(API_URL, getToken)
 */
export async function syncCookieSessionToStorage(
  authClient: LeapifyAuthClient,
): Promise<void> {
  try {
    const result = await authClient.getSession()
    const data = result?.data as { session?: { token?: string } } | undefined
    const token = data?.session?.token
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token)
    }
  } catch {
    // No cookie session — user is a guest.
  }
}

/**
 * Get the current bearer token from storage, or null for guests.
 * Pass this to `createLeapifyClient` as the `getToken` option.
 *
 * @example
 * import { createLeapifyClient } from 'leapify/client'
 * import { createLeapifyAuthClient, getLeapifyToken } from 'leapify/client'
 *
 * const authClient = createLeapifyAuthClient(API_URL)
 * const api = createLeapifyClient(API_URL, () => getLeapifyToken(authClient))
 */
export async function getLeapifyToken(
  // @ts-ignore - Kept for backwards compatibility with previous signature
  authClient?: LeapifyAuthClient,
): Promise<string | null> {
  if (typeof window !== 'undefined') {
    return localStorage.getItem(AUTH_TOKEN_KEY)
  }
  return null
}

/**
 * Sign out the current user.
 */
export async function signOut(authClient: LeapifyAuthClient) {
  const result = await authClient.signOut()
  if (typeof window !== 'undefined') {
    localStorage.removeItem(AUTH_TOKEN_KEY)
  }
  return result
}
