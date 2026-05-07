/**
 * Leapify — Fullstack npm module for DLSU CSO LEAP event websites.
 *
 * This file is the **server-side entry point**. It exports createLeapify(),
 * a Cloudflare Workers-compatible handler. Mount it in your server layer:
 *
 * // Next.js API route / SvelteKit endpoint / Cloudflare Pages Function / worker.ts
 * import { createLeapify } from 'leapify'
 *
 * export default createLeapify({
 *   allowedOrigins: ['https://yourleapsite.com'],
 * })
 *
 * createLeapify() returns { fetch, scheduled, queue } — shaped for CF Workers.
 * See wrangler.toml.example for required bindings (D1, KV, Queues, Crons).
 *
 * For browser / client-component usage, import from 'leapify/client' instead:
 *
 * import { createLeapifyClient, getLeapifyToken } from 'leapify/client'
 * import type { LeapEvent } from 'leapify/types'
 */

if (typeof document !== "undefined") {
  throw new Error(
    "[leapify] This module is server-only (Cloudflare Workers / server runtimes). " +
      "Do not import it in browser or client-component code. " +
      "Use 'leapify/client' for browser-safe typed API utilities.",
  );
}

import { createApp, type LeapifyAppOptions } from "./app";
import { createQueueHandler } from "./queues/handlers";
import { batchRelease } from "./cron/batch-release";
import { reconcileSlots } from "./cron/reconcile-slots";
import { reminderEmails } from "./cron/reminder-emails";
import { lifecycleCheck } from "./cron/lifecycle-check";
import { renewWatches } from "./cron/renew-watches";
import { ensureDatabase } from "./db/migrate";
import type { LeapifyBindings } from "./types";
import type { LeapifyJob } from "./queues/jobs";

export interface LeapifyOptions extends LeapifyAppOptions {
  /**
   * Automatically ensure all required tables exist on first request.
   * Safe for production — idempotent (only runs on fresh databases).
   * @default false
   */
  autoMigrate?: boolean;
}

/**
 * Primary factory function. Returns a Cloudflare Workers-compatible export object.
 *
 * @example
 * // worker.ts — the entire consumer worker implementation
 * import { createLeapify } from 'leapify'
 * export default createLeapify({ allowedOrigins: ['https://yourdomain.com'] })
 */
export function createLeapify(options: LeapifyOptions = {}) {
  const app = createApp(options);
  let loggedEmailConfig = false;
  let migrated = false;

  return {
    /**
     * Cloudflare Workers fetch handler.
     * Handles all HTTP requests routed through Leapify.
     */
    async fetch(
      request: Request,
      env: LeapifyBindings,
      ctx: ExecutionContext,
    ): Promise<Response> {
      if (!loggedEmailConfig) {
        loggedEmailConfig = true;
        const hasSes = !!(
          env.SES_REGION &&
          env.SES_ACCESS_KEY_ID &&
          env.SES_SECRET_ACCESS_KEY
        );
        const hasResend = !!env.RESEND_API_KEY;

        if (!hasSes && !hasResend) {
          console.warn(
            "[leapify] Email functionality is DISABLED (no SES or Resend credentials).",
          );
        }
      }

      if (options.autoMigrate && !migrated) {
        migrated = true;
        try {
          await ensureDatabase(env.DB);
        } catch (err) {
          console.error("[leapify] Auto-migration failed:", err);
        }
      }

      return app.fetch(request, env, ctx);
    },

    // Cloudflare Workers scheduled handler. Routes cron triggers by schedule string.
    // Cron schedule (configured in wrangler.toml):
    //   "* * * * *"   → batch-release
    //   "*/5 * * * *" → reconcile-slots
    //   "0 * * * *"   → reminder-emails + lifecycle-check
    //   "0 0 * * *"   → renew-watches
    async scheduled(
      event: ScheduledEvent,
      env: LeapifyBindings,
      ctx: ExecutionContext,
    ): Promise<void> {
      const { cron } = event;

      if (cron === "* * * * *") await batchRelease(env);
      if (cron === "*/5 * * * *") await reconcileSlots(env);
      if (cron === "0 * * * *") {
        ctx.waitUntil(
          Promise.all([reminderEmails(env), lifecycleCheck(env, ctx)]),
        );
      }
      if (cron === "0 0 * * *") await renewWatches(env);
    },

    /**
     * Cloudflare Queue consumer.
     * Processes async jobs (emails, audit logs, snapshots, watch renewals).
     */
    async queue(
      batch: MessageBatch<LeapifyJob>,
      env: LeapifyBindings,
    ): Promise<void> {
      const handler = createQueueHandler(env);
      return handler(batch);
    },
  };
}

// Re-exports

export { createQueueHandler } from "./queues/handlers";
export { createDb } from "./db";
export { ensureDatabase } from "./db/migrate";
export { createWorkerHandler, type CreateWorkerHandlerOptions } from "./worker-handler";
export { ContentfulManagement } from "./services/contentful-management";
export { ensureContentTypes } from "./services/snapshot";

export type {
  LeapifyBindings,
  LeapifyEnv,
  SiteConfigKey,
  SiteConfigMap,
  CmsMode,
} from "./types";
export { parseCmsMode, shouldPushToContentful, shouldPullFromContentful } from "./types";
export type { LeapifyUser } from "./auth/types";
export type { LeapifyDb } from "./db";
export type { LeapifyJob } from "./queues/jobs";
export type { SlotInfo } from "./services/slots";

/**
 * Runtime config shape injected into HTML pages by the worker.
 * Use on the server side to build the config object.
 */
export interface RuntimeConfig {
  production: boolean;
  leapifyApiUrl: string;
}

/**
 * Build the runtime config from Worker bindings.
 * Used by createWorkerHandler() and standalone workers.
 */
export function getRuntimeConfig(_env: LeapifyBindings): RuntimeConfig {
  return {
    production: true,
    leapifyApiUrl: "",
  };
}

/**
 * Inject runtime config into an HTML string as a window.__CONFIG__ script tag.
 * Used by createWorkerHandler() and standalone workers.
 */
export function injectConfig(html: string, config: RuntimeConfig): string {
  const configScript = `<script>window.__CONFIG__=${JSON.stringify(config)};</script>`;
  return html.replace("</head>", `${configScript}</head>`);
}

// Schema re-exports for consumers running drizzle-kit migrations
export * from "./db/schema";
