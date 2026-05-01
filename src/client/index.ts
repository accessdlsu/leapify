/**
 * Leapify browser-safe API client.
 *
 * Import from 'leapify/client' — no Cloudflare, Drizzle, or Hono dependencies.
 *
 * @example
 * import { createLeapifyClient, createLeapifyAuthClient, getLeapifyToken } from 'leapify/client'
 *
 * const authClient = createLeapifyAuthClient(process.env.NEXT_PUBLIC_API_URL!)
 * const api = createLeapifyClient(
 *   process.env.NEXT_PUBLIC_API_URL!,
 *   () => getLeapifyToken(authClient),
 * )
 *
 * const events = await api.getEvents()
 */

export type {
  LeapEvent,
  SlotInfo,
  UserProfile,
  BookmarkEntry,
  Faq,
  Theme,
  SiteConfig,
  ToggleBookmarkResult,
  LeapifyErrorBody,
  UserRole,
  EventStatus,
} from "./types";

export {
  createLeapifyAuthClient,
  signInWithGoogle,
  getLeapifyToken,
  signOut,
} from "./auth";
export type { LeapifyAuthClient } from "./auth";

/**
 * Structured error thrown by all client methods on non-2xx responses.
 *
 * @example
 * import { LeapifyApiError } from 'leapify/client'
 *
 * try {
 *   await api.toggleBookmark(eventId)
 * } catch (err) {
 *   if (err instanceof LeapifyApiError && err.code === 'UNAUTHORIZED') {
 *     // redirect to sign-in
 *   }
 * }
 */
export class LeapifyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LeapifyApiError";
  }
}

// ─── Error code constants ───────────────────────────────────────────────────

export const LEAPIFY_ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  DOMAIN_RESTRICTED: "DOMAIN_RESTRICTED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type LeapifyErrorCode = keyof typeof LEAPIFY_ERROR_CODES;

// ─── Client factory ─────────────────────────────────────────────────────────

import type {
  LeapEvent,
  SlotInfo,
  UserProfile,
  BookmarkEntry,
  Faq,
  Theme,
  SiteConfig,
  ToggleBookmarkResult,
  LeapifyErrorBody,
} from "./types";

type GetTokenFn = () => Promise<string | null>;

async function buildHeaders(
  getToken: GetTokenFn | undefined,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (getToken) {
    const token = await getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = (body as LeapifyErrorBody)?.error;
    throw new LeapifyApiError(
      res.status,
      err?.code ?? "UNKNOWN",
      err?.message ?? res.statusText,
    );
  }

  return (body as { data: T }).data;
}

/**
 * Creates a typed Leapify API client bound to a base URL.
 *
 * @param baseUrl - The deployed Leapify Worker URL (e.g. `https://api.leap.yourdomain.com`).
 * @param getToken - Optional async function that returns a Firebase ID token string,
 *   or null for guest requests. Use `getLeapifyToken(auth.currentUser)` from this module.
 *
 * @example
 * // lib/api.ts
 * import { createLeapifyClient, getLeapifyToken } from 'leapify/client'
 * import { auth } from './firebase'
 *
 * export const api = createLeapifyClient(
 *   process.env.NEXT_PUBLIC_API_URL!,
 *   () => getLeapifyToken(auth.currentUser),
 * )
 */
export function createLeapifyClient(baseUrl: string, getToken?: GetTokenFn) {
  const base = baseUrl.replace(/\/$/, "");

  async function get<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = await buildHeaders(getToken, init?.headers as Record<string, string>);
    const res = await fetch(`${base}${path}`, { ...init, method: "GET", headers });
    return parseResponse<T>(res);
  }

  async function post<T>(path: string, body?: unknown): Promise<T> {
    const headers = await buildHeaders(getToken);
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return parseResponse<T>(res);
  }

  async function patch<T>(path: string, body: unknown): Promise<T> {
    const headers = await buildHeaders(getToken);
    const res = await fetch(`${base}${path}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    return parseResponse<T>(res);
  }

  async function del<T>(path: string): Promise<T> {
    const headers = await buildHeaders(getToken);
    const res = await fetch(`${base}${path}`, { method: "DELETE", headers });
    return parseResponse<T>(res);
  }

  return {
    // ── Site Config ────────────────────────────────────────────────────────

    /**
     * GET /config
     * Returns site-wide configuration. Check `maintenanceMode` and
     * `comingSoonUntil` on app load to gate the UI appropriately.
     * Use `now` (server unix epoch) for timestamp comparisons.
     */
    getConfig(): Promise<SiteConfig> {
      return get<SiteConfig>("/config");
    },

    /**
     * PATCH /config/:key — admin only.
     * Upserts a site config value. Requires admin or super_admin role.
     */
    updateConfig<K extends string>(key: K, value: unknown): Promise<{ key: K; value: unknown }> {
      return patch(`/config/${encodeURIComponent(key)}`, { value });
    },

    // ── Events ─────────────────────────────────────────────────────────────

    /**
     * GET /events
     * Returns all published events. Response is ETag-cached for 7 days.
     */
    getEvents(): Promise<LeapEvent[]> {
      return get<LeapEvent[]>("/events");
    },

    /**
     * GET /events/:slug
     * Returns a single published event by slug.
     */
    getEvent(slug: string): Promise<LeapEvent> {
      return get<LeapEvent>(`/events/${encodeURIComponent(slug)}`);
    },

    /**
     * GET /events/:slug/slots
     * Returns real-time slot availability. CF edge caches this for 5 seconds.
     * Poll every 8–10 seconds on event detail pages.
     */
    getSlots(slug: string): Promise<SlotInfo> {
      return get<SlotInfo>(`/events/${encodeURIComponent(slug)}/slots`);
    },

    // ── Themes ─────────────────────────────────────────────────────────────

    /**
     * GET /themes
     * Returns all themes.
     */
    getThemes(): Promise<Theme[]> {
      return get<Theme[]>("/themes");
    },

    /**
     * POST /themes — admin only.
     */
    createTheme(data: Omit<Theme, "id" | "createdAt">): Promise<Theme> {
      return post<Theme>("/themes", data);
    },

    /**
     * PATCH /themes/:id — admin only.
     */
    updateTheme(id: string, data: Partial<Omit<Theme, "id" | "createdAt">>): Promise<Theme> {
      return patch<Theme>(`/themes/${encodeURIComponent(id)}`, data);
    },

    /**
     * DELETE /themes/:id — admin only.
     */
    deleteTheme(id: string): Promise<void> {
      return del<void>(`/themes/${encodeURIComponent(id)}`);
    },

    // ── Users ──────────────────────────────────────────────────────────────

    /**
     * GET /users/me
     * Returns the authenticated user's profile, or null for guests.
     * Use `profile.role` to gate admin UI.
     */
    getMe(): Promise<UserProfile | null> {
      return get<UserProfile | null>("/users/me");
    },

    // ── Bookmarks ──────────────────────────────────────────────────────────

    /**
     * GET /users/me/bookmarks
     * Returns the authenticated user's bookmarked events.
     * Returns an empty array for unauthenticated users.
     */
    getBookmarks(): Promise<BookmarkEntry[]> {
      return get<BookmarkEntry[]>("/users/me/bookmarks");
    },

    /**
     * POST /users/me/bookmarks/:eventId
     * Toggles a bookmark on/off. Requires authentication.
     * Returns `{ bookmarked: true }` (201) on add, `{ bookmarked: false }` (200) on remove.
     */
    toggleBookmark(eventId: string): Promise<ToggleBookmarkResult> {
      return post<ToggleBookmarkResult>(
        `/users/me/bookmarks/${encodeURIComponent(eventId)}`,
      );
    },

    /**
     * DELETE /users/me/bookmarks/:eventId
     * Removes a bookmark. Requires authentication.
     */
    deleteBookmark(eventId: string): Promise<ToggleBookmarkResult> {
      return del<ToggleBookmarkResult>(
        `/users/me/bookmarks/${encodeURIComponent(eventId)}`,
      );
    },

    // ── FAQs ───────────────────────────────────────────────────────────────

    /**
     * GET /faqs
     * Returns all active FAQs. Cached in KV for 10 minutes.
     * The `answer` field is markdown — render with a markdown library.
     */
    getFaqs(): Promise<Faq[]> {
      return get<Faq[]>("/faqs");
    },
  };
}

export type LeapifyClient = ReturnType<typeof createLeapifyClient>;
