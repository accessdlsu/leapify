import type {
  D1Database,
  KVNamespace,
  R2Bucket,
  Queue
} from '@cloudflare/workers-types'

export type CmsMode = 'cloudflare' | 'contentful' | 'hybrid'

/**
 * Cloudflare bindings expected in the Worker environment.
 * These map directly to wrangler.toml bindings + Worker Secrets.
 */
export interface LeapifyBindings {
  // Infrastructure bindings (wrangler.toml)
  DB: D1Database
  KV: KVNamespace
  FILES?: R2Bucket
  EMAIL_QUEUE?: Queue
  /**
   * Standalone mode only: comma-separated list of allowed origins.
   * Example: "https://mysite.com,https://www.mysite.com"
   * In npm module mode, pass allowedOrigins to createLeapify() instead.
   */
  ALLOWED_ORIGINS?: string

  // Secrets (set via `wrangler secret put`)
  BETTER_AUTH_SECRET: string
  /**
   * Public HTTPS base URL of this Worker, used by Better Auth for OAuth redirects.
   * Example: "https://leap.yourdomain.com"
   */
  BETTER_AUTH_URL: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  /** Optional Google Workspace hosted domain (e.g. "dlsu.edu.ph"). Restricts the OAuth account picker to this domain. */
  GOOGLE_HD?: string
  GFORMS_SERVICE_ACCOUNT_JSON: string
  GFORMS_WEBHOOK_SECRET: string
  CONTENTFUL_SPACE_ID?: string
  CONTENTFUL_ACCESS_TOKEN?: string
  CONTENTFUL_MANAGEMENT_TOKEN?: string
  CONTENTFUL_ENVIRONMENT?: string
  // Email — Amazon SES (primary/optional)
  SES_REGION?: string
  SES_ACCESS_KEY_ID?: string
  SES_SECRET_ACCESS_KEY?: string
  SES_FROM_ADDRESS?: string
  EMAIL_FROM_NAME?: string
  // Email — Resend (optional fallback; only activated when set)
  RESEND_API_KEY?: string
  RESEND_FROM_ADDRESS?: string
  INTERNAL_API_SECRET: string
  /** PoW challenge difficulty (leading zero bits). Default: 4. Range: 1-8. */
  POW_DIFFICULTY?: string
  /**
   * CMS integration mode. Controls how content is managed.
   * - "cloudflare" — D1/R2 only, no Contentful
   * - "contentful" — Contentful is source of truth, D1 is read cache
   * - "hybrid" — Admin writes to D1, pushes to Contentful (default)
   */
  CMS_MODE?: string
}

/**
 * Hono environment type for use across all route handlers.
 */
export interface LeapifyEnv {
  Bindings: LeapifyBindings
  Variables: {
    user: import('./auth/types').LeapifyUser
    gformsWebhookUrl: string | undefined
    cmsMode: CmsMode
  }
}

/**
 * Parse the CMS_MODE env var into a typed value.
 * Defaults to "hybrid" if not set.
 */
export function parseCmsMode(raw: string | undefined): CmsMode {
  if (raw === 'cloudflare' || raw === 'contentful') return raw
  return 'hybrid'
}

/** Check if Contentful push (D1 → Contentful) is enabled for the given mode. */
export function shouldPushToContentful(mode: CmsMode): boolean {
  return mode === 'hybrid'
}

/** Check if Contentful pull (Contentful → D1) is enabled for the given mode. */
export function shouldPullFromContentful(mode: CmsMode): boolean {
  return mode === 'contentful' || mode === 'hybrid'
}

/**
 * Known site_config keys with their value types.
 */
export interface SiteConfigMap {
  coming_soon_until: number // unix epoch
  site_ends_at: number // unix epoch
  site_name: string
  registration_globally_open: boolean
  maintenance_mode: boolean
  snapshot_completed: boolean
  cms_mode: 'cloudflare' | 'contentful' | 'hybrid'
}

export type SiteConfigKey = keyof SiteConfigMap
