declare global {
  interface Window {
    turnstile: {
      render: (
        container: string | HTMLElement,
        opts: { sitekey: string; callback: (token: string) => void },
      ) => void;
    };
  }
}

const TURNSTILE_VERIFY_PATH = "/.well-known/leapify/turnstile/verify";

function getTurnstileSiteKey(): string | undefined {
  const config = (window as unknown as Record<string, unknown>).__CONFIG__ as
    | { turnstileSiteKey?: string }
    | undefined;
  return config?.turnstileSiteKey;
}

function loadTurnstileScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window.turnstile !== "undefined") {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Turnstile script"));
    document.head.appendChild(script);
  });
}

function executeTurnstile(siteKey: string): Promise<string> {
  return new Promise((resolve) => {
    const container = document.createElement("div");
    container.id = "leapify-turnstile-container";
    container.style.display = "none";
    document.body.appendChild(container);

    // Timeout guard — Turnstile iframe can hang if postMessage origin mismatch
    // or other widget issues prevent the callback from firing.
    // After 10s, continue without the cookie; the server-side auth middleware
    // will handle verified sessions via the Authorization header instead.
    const timer = setTimeout(() => {
      container.remove();
      resolve("");
    }, 10_000);

    window.turnstile.render(`#${container.id}`, {
      sitekey: siteKey,
      callback: (token: string) => {
        clearTimeout(timer);
        container.remove();
        resolve(token);
      },
    });
  });
}

/**
 * Solve a Turnstile challenge and obtain a signed cookie from the backend.
 *
 * Loads the Turnstile script (if not already loaded), executes an invisible
 * challenge, and posts the token to the backend verify endpoint. The server
 * sets a signed cookie that bypasses Turnstile for subsequent requests.
 *
 * Call once on app initialization before any API requests.
 *
 * @param baseUrl - The Leapify Worker URL. If omitted, uses the current origin.
 * @param siteKey - Turnstile site key. If omitted, reads from window.__CONFIG__.
 * @returns `true` if the challenge was solved and cookie was set.
 */
export async function solveTurnstileChallenge(
  baseUrl?: string,
  siteKey?: string,
): Promise<boolean> {
  siteKey = siteKey ?? getTurnstileSiteKey();
  if (!siteKey) return false;

  const base = baseUrl?.replace(/\/$/, "") ?? "";

  try {
    await loadTurnstileScript();
    const token = await executeTurnstile(siteKey);

    const res = await fetch(`${base}${TURNSTILE_VERIFY_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "include",
    });

    return res.ok;
  } catch {
    return false;
  }
}
