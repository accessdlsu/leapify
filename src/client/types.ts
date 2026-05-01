/**
 * Browser-safe TypeScript types for the Leapify API.
 * Import from 'leapify/types' — no Cloudflare, Drizzle, or Hono dependencies.
 */

export type EventStatus = "draft" | "queued" | "published" | "ended" | "cancelled";

export type UserRole = "student" | "admin" | "super_admin";

/**
 * A theme categorization for events.
 */
export interface Theme {
  id: string;
  name: string;
  path: string;
  color: string | null;
  createdAt: number;
}

/**
 *
 * Note: The list endpoint (GET /events) returns a subset of fields for
 * performance — internal fields like gformsId, watchId, and reminder flags
 * are omitted. The detail endpoint (GET /events/:slug) returns the full shape.
 * This type covers the union of both; extra fields are nullable/optional.
 */
export interface LeapEvent {
  id: string;
  slug: string;
  themeId: string | null;
  theme: {
    id: string;
    name: string;
    path: string;
    color: string | null;
  } | null;
  title: string;
  org: string | null;
  venue: string | null;
  dateTime: string | null;
  startsAt: number | null;
  endsAt: number | null;
  price: string | null;
  backgroundColor: string | null;
  backgroundImageUrl: string | null;
  subtheme: string | null;
  isMajor: boolean;
  maxSlots: number;
  registeredSlots: number;
  gformsUrl: string | null;
  registrationOpensAt: number | null;
  registrationClosesAt: number | null;
  publishedAt: number | null;
  // Present only on GET /events/:slug
  status?: EventStatus;
  createdAt?: number;
}

/**
 * Real-time slot availability from GET /events/:slug/slots.
 * Refreshes every 5 seconds at the CF edge.
 */
export interface SlotInfo {
  available: number;
  total: number;
  registered: number;
  isFull: boolean;
}

/**
 * Authenticated user profile from GET /users/me.
 * Returns null if the request is unauthenticated.
 */
export interface UserProfile {
  id: string;
  firebaseUid: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: number;
}

/**
 * A single entry in the user's bookmark list from GET /users/me/bookmarks.
 */
export interface BookmarkEntry {
  bookmarkedAt: number;
  event: LeapEvent;
}

/**
 * A single FAQ item from GET /faqs.
 * The `answer` field is markdown.
 */
export interface Faq {
  id: string;
  question: string;
  answer: string;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Site-wide configuration from GET /config.
 * Use `now` (server unix epoch) for timestamp comparisons to avoid
 * client clock drift.
 */
export interface SiteConfig {
  comingSoonUntil: number | null;
  siteEndsAt: number | null;
  siteName: string | null;
  registrationGloballyOpen: boolean;
  maintenanceMode: boolean;
  now: number;
}

/**
 * Result of POST /users/me/bookmarks/:eventId (toggle) and
 * DELETE /users/me/bookmarks/:eventId.
 */
export interface ToggleBookmarkResult {
  bookmarked: boolean;
}

/**
 * Standard error response shape from the Leapify API.
 * Thrown as LeapifyApiError by the client.
 */
export interface LeapifyErrorBody {
  error: {
    code: string;
    message: string;
  };
}
