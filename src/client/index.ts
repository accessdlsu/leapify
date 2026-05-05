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
  CreateEventBody,
  CreateFaqBody,
  SnapshotResult,
  HealthResponse,
  RuntimeConfig,
} from "./types";

export {
  createLeapifyAuthClient,
  signInWithGoogleRedirect,
  syncCookieSessionToStorage,
  getLeapifyToken,
  signOut,
} from "./auth";
export type { LeapifyAuthClient } from "./auth";

export { solvePowChallenge } from "./pow";
export { initializeSession } from "./session";

/**
 * Read the runtime config injected by the worker into HTML pages.
 * Returns null if not running in a browser or config not injected.
 */
export function getClientConfig(): RuntimeConfig | null {
  if (typeof window === "undefined") return null;
  const config = (window as unknown as Record<string, unknown>).__CONFIG__;
  if (!config || typeof config !== "object") return null;
  return config as RuntimeConfig;
}

import type { RuntimeConfig } from "./types";

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
  CreateEventBody,
  CreateFaqBody,
  SnapshotResult,
  HealthResponse,
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
 * @param getToken - Optional async function that returns a session token string,
 *   or null for guest requests. Use `getLeapifyToken()` from this module.
 *
 * @example
 * // lib/api.ts
 * import { createLeapifyClient, getLeapifyToken } from 'leapify/client'
 *
 * export const api = createLeapifyClient(
 *   process.env.NEXT_PUBLIC_API_URL!,
 *   () => getLeapifyToken(),
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

  async function postFormData<T>(path: string, formData: FormData): Promise<T> {
    const headers: Record<string, string> = {};
    if (getToken) {
      const token = await getToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: formData,
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
      return get<SiteConfig>("/api/config");
    },

    /**
     * PATCH /api/config/:key — admin only.
     * Upserts a site config value. Requires admin or super_admin role.
     */
    updateConfig<K extends string>(key: K, value: unknown): Promise<{ key: K; value: unknown }> {
      return patch(`/api/config/${encodeURIComponent(key)}`, { value });
    },

    // ── Events ─────────────────────────────────────────────────────────────

    /**
     * GET /api/events
     * Returns all published events. Response is ETag-cached for 7 days.
     */
    getEvents(): Promise<LeapEvent[]> {
      return get<LeapEvent[]>("/api/events");
    },

    /**
     * GET /api/events/:slug
     * Returns a single published event by slug.
     */
    getEvent(slug: string): Promise<LeapEvent> {
      return get<LeapEvent>(`/api/events/${encodeURIComponent(slug)}`);
    },

    /**
     * GET /api/events/:slug/slots
     * Returns real-time slot availability. CF edge caches this for 5 seconds.
     * Poll every 8–10 seconds on event detail pages.
     */
    getSlots(slug: string): Promise<SlotInfo> {
      return get<SlotInfo>(`/api/events/${encodeURIComponent(slug)}/slots`);
    },

    /**
     * POST /api/events — admin only.
     * Creates a new event. Auto-generates slug from title.
     */
    createEvent(data: CreateEventBody): Promise<LeapEvent> {
      return post<LeapEvent>("/api/events", data);
    },

    /**
     * PATCH /api/events/:slug — admin only.
     * Updates an existing event by slug.
     */
    updateEvent(slug: string, data: Partial<CreateEventBody>): Promise<LeapEvent> {
      return patch<LeapEvent>(`/api/events/${encodeURIComponent(slug)}`, data);
    },

    // ── Themes ─────────────────────────────────────────────────────────────

    /**
     * GET /api/themes
     * Returns all themes.
     */
    getThemes(): Promise<Theme[]> {
      return get<Theme[]>("/api/themes");
    },

    /**
     * POST /api/themes — admin only.
     */
    createTheme(data: Omit<Theme, "id" | "createdAt">): Promise<Theme> {
      return post<Theme>("/api/themes", data);
    },

    /**
     * PATCH /api/themes/:id — admin only.
     */
    updateTheme(id: string, data: Partial<Omit<Theme, "id" | "createdAt">>): Promise<Theme> {
      return patch<Theme>(`/api/themes/${encodeURIComponent(id)}`, data);
    },

    /**
     * DELETE /api/themes/:id — admin only.
     */
    deleteTheme(id: string): Promise<void> {
      return del<void>(`/api/themes/${encodeURIComponent(id)}`);
    },

    // ── Users ──────────────────────────────────────────────────────────────

    /**
     * GET /api/users/me
     * Returns the authenticated user's profile, or null for guests.
     * Use `profile.role` to gate admin UI.
     */
    getMe(): Promise<UserProfile | null> {
      return get<UserProfile | null>("/api/users/me");
    },

    // ── Bookmarks ──────────────────────────────────────────────────────────

    /**
     * GET /api/users/me/bookmarks
     * Returns the authenticated user's bookmarked events.
     * Returns an empty array for unauthenticated users.
     */
    getBookmarks(): Promise<BookmarkEntry[]> {
      return get<BookmarkEntry[]>("/api/users/me/bookmarks");
    },

    /**
     * POST /api/users/me/bookmarks/:eventId
     * Toggles a bookmark on/off. Requires authentication.
     * Returns `{ bookmarked: true }` (201) on add, `{ bookmarked: false }` (200) on remove.
     */
    toggleBookmark(eventId: string): Promise<ToggleBookmarkResult> {
      return post<ToggleBookmarkResult>(
        `/api/users/me/bookmarks/${encodeURIComponent(eventId)}`,
      );
    },

    /**
     * DELETE /api/users/me/bookmarks/:eventId
     * Removes a bookmark. Requires authentication.
     */
    deleteBookmark(eventId: string): Promise<ToggleBookmarkResult> {
      return del<ToggleBookmarkResult>(
        `/api/users/me/bookmarks/${encodeURIComponent(eventId)}`,
      );
    },

    // ── FAQs ───────────────────────────────────────────────────────────────

    /**
     * GET /api/faqs
     * Returns all active FAQs. Cached in KV for 10 minutes.
     * The `answer` field is markdown — render with a markdown library.
     */
    getFaqs(): Promise<Faq[]> {
      return get<Faq[]>("/api/faqs");
    },

    /**
     * POST /api/faqs — admin only.
     * Creates a new FAQ item.
     */
    createFaq(data: CreateFaqBody): Promise<Faq> {
      return post<Faq>("/api/faqs", data);
    },

    /**
     * PATCH /api/faqs/:id — admin only.
     * Updates an existing FAQ item.
     */
    updateFaq(id: string, data: Partial<CreateFaqBody>): Promise<Faq> {
      return patch<Faq>(`/api/faqs/${encodeURIComponent(id)}`, data);
    },

    /**
     * DELETE /api/faqs/:id — admin only.
     * Soft-deletes a FAQ (sets isActive: false).
     */
    deleteFaq(id: string): Promise<{ deleted: boolean }> {
      return del<{ deleted: boolean }>(`/api/faqs/${encodeURIComponent(id)}`);
    },

    // ── Uploads ────────────────────────────────────────────────────────────

    /**
     * POST /api/uploads/images — admin only.
     * Uploads an image file to R2. Accepts multipart/form-data.
     * Returns the public URL, storage key, size, and content type.
     */
    uploadImage(file: File | Blob): Promise<{
      url: string;
      key: string;
      size: number;
      contentType: string;
    }> {
      const formData = new FormData();
      formData.append("file", file);
      return postFormData("/api/uploads/images", formData);
    },

    // ── Content Sync ───────────────────────────────────────────────────────

    /**
     * POST /api/config/sync-content — admin only.
     * Pushes all D1 content to Contentful. Auto-generates content types if missing.
     */
    syncContent(): Promise<SnapshotResult> {
      return post<SnapshotResult>("/api/config/sync-content");
    },

    // ── Health ─────────────────────────────────────────────────────────────

    /**
     * GET /health
     * Public health check. Returns provider availability status.
     */
    healthCheck(): Promise<HealthResponse> {
      return get<HealthResponse>("/health");
    },
  };
}

export type LeapifyClient = ReturnType<typeof createLeapifyClient>;
