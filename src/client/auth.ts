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
 * import { createLeapifyAuthClient, signInWithGoogle } from 'leapify/client'
 *
 * export const authClient = createLeapifyAuthClient(process.env.NEXT_PUBLIC_API_URL!)
 *
 * // When GIS gives you a credential string:
 * google.accounts.id.initialize({
 *   client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!,
 *   callback: async ({ credential }) => {
 *     await signInWithGoogle(authClient, credential)
 *   },
 * })
 */

import { createAuthClient } from 'better-auth/client'

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
            return localStorage.getItem('better-auth.session_token') || ''
          }
          return ''
        }
      }
    }
  })
}

export type LeapifyAuthClient = ReturnType<typeof createLeapifyAuthClient>

/**
 * Sign in with a Google Identity Services (GIS) credential string.
 *
 * Pass the `credential` from the GIS callback directly — Better Auth's
 * Google provider verifies the ID token server-side via Google's JWKS.
 *
 * @param authClient - Client created by createLeapifyAuthClient
 * @param credential - The credential string from google.accounts.id callback
 *
 * @example
 * google.accounts.id.initialize({
 *   client_id: GOOGLE_CLIENT_ID,
 *   callback: async ({ credential }) => {
 *     const result = await signInWithGoogle(authClient, credential)
 *     if (result.error) console.error(result.error)
 *   },
 * })
 */
export async function signInWithGoogle(
  authClient: LeapifyAuthClient,
  credential: string,
) {
  return authClient.signIn.social({
    provider: 'google',
    idToken: { token: credential },
  }, {
    onSuccess: (ctx) => {
      const authToken = ctx.response.headers.get("set-auth-token")
      if (authToken && typeof window !== 'undefined') {
        localStorage.setItem('better-auth.session_token', authToken)
      }
    }
  })
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
    return localStorage.getItem('better-auth.session_token')
  }
  return null
}

/**
 * Sign out the current user.
 */
export async function signOut(authClient: LeapifyAuthClient) {
  const result = await authClient.signOut()
  if (typeof window !== 'undefined') {
    localStorage.removeItem('better-auth.session_token')
  }
  return result
}
