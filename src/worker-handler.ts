/**
 * Worker handler factory — eliminates duplicated worker entry boilerplate.
 *
 * Encapsulates: API prefix routing, lazy singleton init, config injection,
 * and fetch/scheduled/queue delegation. Consumer provides only the
 * "serve the frontend" callback.
 *
 * Import from 'leapify' — server-only.
 *
 * @example
 * // worker.ts (Angular console)
 * import { createWorkerHandler } from 'leapify'
 * import { AngularAppEngine } from '@angular/ssr'
 *
 * const angularApp = new AngularAppEngine({ ... })
 *
 * export default createWorkerHandler({
 *   serveFrontend: async (request, env) => {
 *     const res = await angularApp.handle(request, { env })
 *     return res ?? new Response('Not found', { status: 404 })
 *   },
 * })
 */

import { createLeapify } from "./index";
import type { LeapifyBindings } from "./types";
import type { LeapifyJob } from "./queues/jobs";

const API_PREFIXES = [
  "/api/auth/",
  "/api/classes",
  "/api/users",
  "/api/organizations",
  "/api/faqs",
  "/api/themes",
  "/api/config",
  "/api/uploads",
  "/api/docs",
  "/api/openapi.json",
  "/health",
  "/internal/",
  "/.well-known/",
];

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export interface RuntimeConfig {
  production: boolean;
  leapifyApiUrl: string;
  turnstileSiteKey?: string;
}

export interface CreateWorkerHandlerOptions {
  /** CORS origins. Falls back to ALLOWED_ORIGINS env var, then ["*"]. */
  allowedOrigins?: string[];
  /**
   * Public HTTPS URL of your Worker.
   * Required for Google Forms Watch push notifications.
   */
  gformsWebhookUrl?: string;
  /**
   * Automatically ensure all required tables exist on first request.
   * Safe for production — idempotent (only runs on fresh databases).
   * @default false
   */
  autoMigrate?: boolean;
  /**
   * Serve the frontend (SSR or static assets).
   * Return a Response for HTML pages, or null for non-HTML requests.
   * The factory handles config injection into HTML responses automatically.
   */
  serveFrontend: (
    request: Request,
    env: LeapifyBindings,
    ctx: ExecutionContext,
  ) => Promise<Response | null>;
  /**
   * Build the runtime config object injected into HTML pages.
   * Defaults to extracting LEAPIFY_API_URL and GOOGLE_CLIENT_ID from env.
   */
  getRuntimeConfig?: (env: LeapifyBindings) => RuntimeConfig;
}

function defaultGetRuntimeConfig(env: LeapifyBindings): RuntimeConfig {
  return {
    production: true,
    leapifyApiUrl: "",
    ...(env.TURNSTILE_SITE_KEY ? { turnstileSiteKey: env.TURNSTILE_SITE_KEY } : {}),
  };
}

function injectConfig(html: string, config: RuntimeConfig): string {
  const configScript = `<script>window.__CONFIG__=${JSON.stringify(config)};</script>`;
  return html.replace("</head>", `${configScript}</head>`);
}

/**
 * Create a complete Cloudflare Worker handler with API routing + frontend serving.
 */
export function createWorkerHandler(options: CreateWorkerHandlerOptions) {
  const getConfig = options.getRuntimeConfig ?? defaultGetRuntimeConfig;
  let leapify: ReturnType<typeof createLeapify> | null = null;

  function getLeapify(env: LeapifyBindings) {
    if (!leapify) {
      const origins =
        options.allowedOrigins ??
        env.ALLOWED_ORIGINS?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) ??
        ["*"];
      leapify = createLeapify({
        allowedOrigins: origins,
        ...(options.autoMigrate !== undefined ? { autoMigrate: options.autoMigrate } : {}),
        ...(options.gformsWebhookUrl !== undefined
          ? { gformsWebhookUrl: options.gformsWebhookUrl }
          : {}),
      });
    }
    return leapify;
  }

  return {
    async fetch(
      request: Request,
      env: LeapifyBindings,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const { pathname } = new URL(request.url);

      if (isApiPath(pathname)) {
        return getLeapify(env).fetch(request, env, ctx);
      }

      let response = await options.serveFrontend(request, env, ctx);

      // SPA fallback: if no matching file and path has no extension,
      // serve index.html so the client-side router handles it.
      // Only do this for GET requests to avoid disturbing bodies of other methods.
      if ((!response || response.status === 404) && !pathname.includes(".") && request.method === "GET") {
        const indexRequest = new Request(new URL("/", request.url), request);
        response = await options.serveFrontend(indexRequest, env, ctx);
      }

      if (!response) {
        return new Response("Not found", { status: 404 });
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("text/html")) {
        const config = getConfig(env);
        const html = await response.text();
        const modifiedHtml = injectConfig(html, config);
        return new Response(modifiedHtml, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      return response;
    },

    async scheduled(
      event: ScheduledEvent,
      env: LeapifyBindings,
      ctx: ExecutionContext,
    ): Promise<void> {
      return getLeapify(env).scheduled(event, env, ctx);
    },

    async queue(
      batch: MessageBatch<LeapifyJob>,
      env: LeapifyBindings,
    ): Promise<void> {
      return getLeapify(env).queue(batch, env);
    },
  };
}
