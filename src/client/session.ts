/**
 * Browser-safe session initialization helper.
 *
 * Solves the PoW challenge (if active), checks for an existing session token,
 * and fetches the user profile. Returns the authenticated user or null.
 *
 * Import from 'leapify/client' — no Cloudflare, Drizzle, or Hono deps.
 *
 * @example
 * import { initializeSession, createLeapifyClient } from 'leapify/client'
 *
 * const user = await initializeSession(
 *   'https://api.leap.yourdomain.com',
 *   () => getLeapifyToken(),
 * )
 * if (user) {
 *   console.log(`Welcome ${user.name} (${user.role})`)
 * }
 */

import { solvePowChallenge } from "./pow";
import type { UserProfile } from "./types";

/**
 * Initialize a browser session: solve PoW, restore existing token, fetch profile.
 *
 * @param baseUrl - The Leapify Worker URL.
 * @param getToken - Async function returning the current session token, or null.
 * @returns The authenticated user profile, or null if not signed in.
 */
export async function initializeSession(
  baseUrl: string,
  getToken: () => Promise<string | null>,
): Promise<UserProfile | null> {
  await solvePowChallenge(baseUrl);

  const token = await getToken();
  if (!token) return null;

  const base = baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) return null;

  const body = await res.json().catch(() => ({}));
  return (body as { data: UserProfile | null }).data ?? null;
}
