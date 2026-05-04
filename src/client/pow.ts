/**
 * Browser-safe Proof-of-Work challenge solver.
 *
 * Solves the SHA-256 PoW challenge served by the leapify backend middleware.
 * After solving, the server sets a signed cookie (1h TTL) so subsequent
 * requests bypass the challenge automatically.
 *
 * Import from 'leapify/client' — no Cloudflare, Drizzle, or Hono deps.
 *
 * @example
 * import { solvePowChallenge } from 'leapify/client'
 *
 * // Call once on app load before any API requests
 * await solvePowChallenge('https://api.leap.yourdomain.com')
 */

const POW_VERIFY_PATH = "/.well-known/leapify/pow/verify";

/**
 * Solve the backend's Proof-of-Work challenge if one is active.
 *
 * Probes the given base URL for an HTML challenge page. If detected,
 * brute-forces a SHA-256 nonce (~100-500ms) and submits the solution.
 * The resulting cookie covers all API paths for 1 hour.
 *
 * @param baseUrl - The Leapify Worker URL (e.g. `https://api.leap.yourdomain.com`).
 *   If omitted, uses the current page origin (same-origin requests).
 * @returns `true` if a challenge was solved, `false` if no challenge was needed.
 */
export async function solvePowChallenge(baseUrl?: string): Promise<boolean> {
  const base = baseUrl?.replace(/\/$/, "") ?? "";

  let html: string;
  try {
    const res = await fetch(`${base}/events`, { credentials: "include" });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      return false;
    }
    html = await res.text();
  } catch {
    return false;
  }

  const idMatch = html.match(/challengeId\s*=\s*"([^"]+)"/);
  const diffMatch = html.match(/difficulty\s*=\s*(\d+)/);
  if (!idMatch || !diffMatch) {
    return false;
  }

  const challengeId = idMatch[1];
  const difficulty = Number(diffMatch[1]);
  const prefix = "0".repeat(Math.ceil(difficulty / 4));

  let nonce = 0;
  while (true) {
    const input = new TextEncoder().encode(`${challengeId}:${nonce}`);
    const hash = await crypto.subtle.digest("SHA-256", input);
    const hex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hex.startsWith(prefix)) {
      await fetch(`${base}${POW_VERIFY_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: challengeId, nonce, elapsed: 0 }),
        credentials: "include",
      });
      return true;
    }
    nonce++;
  }
}
