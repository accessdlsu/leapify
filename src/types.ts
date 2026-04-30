import type {
  D1Database,
  KVNamespace,
  R2Bucket,
  Queue,
} from '@cloudflare/workers-types'

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
  GFORMS_SERVICE_ACCOUNT_JSON: string
  GFORMS_WEBHOOK_SECRET: string
  CONTENTFUL_SPACE_ID?: string
  CONTENTFUL_ACCESS_TOKEN?: string
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
}

/**
 * Hono environment type for use across all route handlers.
 */
export interface LeapifyEnv {
  Bindings: LeapifyBindings
  Variables: {
    user: import('./auth/types').LeapifyUser
    gformsWebhookUrl: string | undefined
  }
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
}

export type SiteConfigKey = keyof SiteConfigMap
