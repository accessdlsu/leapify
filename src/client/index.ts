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
  Organization,
  SiteConfig,
  ToggleBookmarkResult,
  LeapifyErrorBody,
  UserRole,
  EventStatus,
  CreateEventBody,
  CreateFaqBody,
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

export { solveTurnstileChallenge } from "./turnstile";
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
  Organization,
  SiteConfig,
  ToggleBookmarkResult,
  LeapifyErrorBody,
  CreateEventBody,
  CreateFaqBody,
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
     * GET /api/classes
     * Returns all published classes. Response is ETag-cached for 7 days.
     */
    getEvents(): Promise<LeapEvent[]> {
      return get<LeapEvent[]>("/api/classes");
    },

    /**
     * GET /api/classes/admin — admin only.
     * Returns all classes regardless of status.
     */
    getAdminEvents(): Promise<LeapEvent[]> {
      return get<LeapEvent[]>("/api/classes/admin");
    },

    /**
     * POST /api/classes/admin/publish — admin only.
     * Batch publish queued classes immediately or schedule them for later.
     */
    batchPublish(ids: string[], releaseAt?: number): Promise<{ updated: number }> {
      return post("/api/classes/admin/publish", { ids, releaseAt });
    },

    /**
     * GET /api/classes/:slug
     * Returns a single published class by slug.
     */
    getEvent(slug: string): Promise<LeapEvent> {
      return get<LeapEvent>(`/api/classes/${encodeURIComponent(slug)}`);
    },

    /**
     * GET /api/classes/:slug/slots
     * Returns real-time slot availability. CF edge caches this for 5 seconds.
     * Poll every 8–10 seconds on class detail pages.
     */
    getSlots(slug: string): Promise<SlotInfo> {
      return get<SlotInfo>(`/api/classes/${encodeURIComponent(slug)}/slots`);
    },

    /**
     * POST /api/classes/:slug/reconcile — admin only.
     * Corrects slot count for a single event by fetching the real Google Forms response count.
     */
    reconcileEvent(slug: string): Promise<{ registeredSlots: number }> {
      return post<{ registeredSlots: number }>(`/api/classes/${encodeURIComponent(slug)}/reconcile`);
    },

    /**
     * POST /api/classes — admin only.
     * Creates a new class. Auto-generates slug from title.
     */
    createEvent(data: CreateEventBody): Promise<LeapEvent> {
      return post<LeapEvent>("/api/classes", data);
    },

    /**
     * PATCH /api/classes/:slug — admin only.
     * Updates an existing class by slug.
     */
    updateEvent(slug: string, data: Partial<CreateEventBody>): Promise<LeapEvent> {
      return patch<LeapEvent>(`/api/classes/${encodeURIComponent(slug)}`, data);
    },

    /**
     * DELETE /api/classes/:slug — admin only.
     * Deletes a class.
     */
    deleteEvent(slug: string): Promise<void> {
      return del<void>(`/api/classes/${encodeURIComponent(slug)}`);
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
    createTheme(data: Omit<Theme, "id" | "createdAt" | "path"> & { path?: string }): Promise<Theme> {
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

    // ── Organizations ──────────────────────────────────────────────────────

    /**
     * GET /api/organizations
     * Returns all organizations.
     */
    getOrganizations(): Promise<Organization[]> {
      return get<Organization[]>("/api/organizations");
    },

    /**
     * POST /api/organizations — admin only.
     */
    createOrganization(data: Omit<Organization, "id" | "createdAt">): Promise<Organization> {
      return post<Organization>("/api/organizations", data);
    },

    /**
     * PATCH /api/organizations/:id — admin only.
     */
    updateOrganization(id: string, data: Partial<Omit<Organization, "id" | "createdAt">>): Promise<Organization> {
      return patch<Organization>(`/api/organizations/${encodeURIComponent(id)}`, data);
    },

    /**
     * DELETE /api/organizations/:id — admin only.
     */
    deleteOrganization(id: string): Promise<void> {
      return del<void>(`/api/organizations/${encodeURIComponent(id)}`);
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

    // ── Admin: User Management ────────────────────────────────────────────

    /**
     * GET /api/users — admin only.
     * Returns all registered users.
     */
    getUsers(): Promise<UserProfile[]> {
      return get<UserProfile[]>("/api/users");
    },

    /**
     * PATCH /api/users/:id/role — admin only.
     * Changes a user's role.
     */
    updateUserRole(id: string, role: string): Promise<UserProfile> {
      return patch<UserProfile>(`/api/users/${encodeURIComponent(id)}/role`, { role });
    },

    /**
     * POST /api/users/by-email — admin only.
     * Finds or creates a user by email and sets their role.
     */
    upsertUserByEmail(email: string, role: string): Promise<UserProfile> {
      return post<UserProfile>("/api/users/by-email", { email, role });
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
