# LLM Agent — Leapify Backend

## Role

Senior Systems Architect for **30,000+ concurrent students**. Design API contracts, data flows, and service boundaries. Do not write implementation code.

---

## Context

**Product:** Leapify — server-only npm module powering DLSU CSO LEAP event websites.
Frontend devs install `leapify` and consume its `/api/` endpoints. All secrets (Firebase, Contentful, Resend, CF bindings) live in `.env` / `wrangler.toml` — never in client code.

**Scale:** 30,000 concurrent users · 10k req/s peak · <100ms p95 reads · <500ms p95 writes
**Runtime:** Cloudflare Workers (Edge)
**Non-negotiable:** Firebase Auth rate limits (~50 QPS) → cache tokens in KV

---

## Architecture (Implementation Detail)

Dual-mode npm package: installable as a library (`leapify`) or deployable as a standalone Cloudflare Worker (`dist/worker.js`). Both modes share identical routes, auth, and services.

### Request Flow

```
Request → CORS middleware (origin check, /health exempt)
        → Maintenance mode (KV check, /health and /internal exempt)
        → Route handler
        → Auth middleware (if protected route)
        → Service layer → Repository layer (Drizzle) → D1
        → Response envelope: { data: T } or { error: { code, message } }
```

---

## Tech Stack

| Layer      | Choice                                      |
| ---------- | ------------------------------------------- |
| Framework  | Hono (edge-optimized, <1ms cold start)      |
| ORM        | Drizzle with D1 adapter                     |
| Validation | Zod                                         |
| Cache      | Cloudflare (KV + CDN edge cache + CF Cache) |
| CMS        | Contentful (headless CMS, REST/GraphQL)     |
| Async Jobs | Cloudflare Queues + DLQ                     |
| Testing    | Vitest + `@cloudflare/vitest-pool-workers`  |

---

## Build & Dev Commands

```bash
npm run build          # tsup — produces dist/ (ESM + CJS) and dist/worker.js
npm run dev            # tsup --watch (library only, no wrangler)
npm run start          # build + wrangler dev (local Worker with D1/KV)
npm run deploy         # build + wrangler deploy
npm run test           # vitest in watch mode
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit
npm run db:generate    # drizzle-kit generate (schema → SQL migration in /drizzle)
npm run db:migrate     # drizzle-kit migrate (apply migrations to D1)
```

Run a single test file: `npx vitest run tests/events.test.ts`
Run tests matching a pattern: `npx vitest run -t "bookmarks"`

---

## Key Conventions

### npm Module & API Exposure

- Leapify is **installed as an npm package** by frontend teams (`npm install leapify`).
- The backend exposes all endpoints under `/api/` — these **must only accept requests from the site's own origin** (CORS `allowedOrigins` enforced at the Hono layer).
- **Exception:** `GET /health` is publicly accessible from any origin (used for uptime monitoring).
- All third-party API keys (Firebase, Contentful, Resend) are stored in `.env` / Worker secrets — never exposed to the browser.

### API Contract

| Rule              | Detail                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| Response envelope | `{ data: T }` success · `{ error: { code, message } }` error            |
| Status codes      | 200, 201, 204, 400, 401, 403, 404, 422, 429, 503                        |
| Caching           | `Cache-Control: public, max-age=604800` + ETag for read-heavy endpoints |
| Pagination        | `?limit=20&offset=0` (default 50, max 100)                              |
| No URL versioning | Breaking changes = major version bump in `package.json`                 |
| CORS              | `/api/*` restricted to `allowedOrigins` · `/health` open to all origins |

### Auth Model

| Role  | Token                               | Access                   |
| ----- | ----------------------------------- | ------------------------ |
| guest | None                                | Public endpoints only    |
| user  | Valid Firebase JWT (`@dlsu.edu.ph`) | Protected user endpoints |
| admin | JWT + `admin: true` claim           | Admin mutation endpoints |

### Directory Structure (Core)

```
src/
├── routes/          # Route handlers (events, users, faqs, site-config, health)
├── auth/            # middleware.ts · jwt.ts · cache.ts (KV token cache)
├── db/
│   └── schema/      # Drizzle schemas + relations (events, users, bookmarks)
├── services/        # Business logic (CacheService, SlotsService, EmailRouter, GFormsService)
├── repositories/    # Drizzle queries (EventRepo, UserRepo, BookmarkRepo)
├── queues/          # jobs.ts (LeapifyJob union) · handlers.ts (createQueueHandler)
├── cron/            # batch-release, reconcile-slots, reminder-emails, lifecycle-check, renew-watches
├── lib/             # errors.ts · cache.ts · queue.ts · validation.ts
└── client/          # Browser-safe typed API client (separate bundle)
```

### Auth Chain (`src/auth/`)

1. **`middleware.ts`** — Three middlewares: `authMiddleware` (required), `optionalAuthMiddleware`, `adminMiddleware`
2. Auth flow: Extract Bearer token → base64-decode payload for UID → KV cache lookup (`auth:user:<uid>`) → if miss: verify JWT via Google JWK certs (`jwt.ts`) + KV-cached certs → enforce `@dlsu.edu.ph` domain → upsert user in D1 → cache `LeapifyUser` in KV (TTL capped at token expiry, max 1h)

### Service Layer (`src/services/`)

| Service                       | Responsibility                                                           |
| ----------------------------- | ------------------------------------------------------------------------ |
| `cache.ts` — `CacheService`   | Wraps KV with `getOrSet` (stale-while-revalidate) and ETag generation    |
| `slots.ts` — `SlotsService`   | Manages event slot counts (KV → D1 fallback, atomic increment/decrement) |
| `email.ts` — `EmailRouter`    | SES primary / Resend fallback routing                                    |
| `gforms.ts` — `GFormsService` | Google Forms API integration (watches, respondent emails)                |
| `resend.ts` / `ses.ts`        | Email provider implementations                                           |

### Key Infrastructure

- **DB**: Drizzle ORM with D1 adapter (`src/db/`). `createDb(d1)` returns typed Drizzle instance. Schemas in `src/db/schema/`. Migrations in `/drizzle` directory (SQLite dialect).
- **Queues**: `src/queues/jobs.ts` defines `LeapifyJob` discriminated union. `src/queues/handlers.ts` processes batch via `createQueueHandler(env)`.
- **Cron**: `src/cron/` — batch-release, reconcile-slots, reminder-emails, lifecycle-check, renew-watches. Scheduled via `wrangler.jsonc` triggers (currently commented out).
- **Client**: `src/client/` — browser-safe typed API client. Separate tsup bundle (`leapify/client`). No server dependencies.

### Route Structure

Routes mount at: `/health`, `/config`, `/events`, `/users`, `/faqs`, `/internal/gforms-webhook`

Internal routes require `X-Internal-Secret` header matching `INTERNAL_API_SECRET`.

---

### Entry Points (tsup builds both)

- **`src/index.ts`** → `createLeapify()` factory. Returns `{ fetch, scheduled, queue }` shaped for CF Workers. Library consumers import this. Contains a `typeof document` guard to prevent browser imports.
- **`src/worker.ts`** → Standalone CF Worker entry. Parses `ALLOWED_ORIGINS` env var, creates singleton app instance, exports `fetch`/`scheduled`/`queue` handlers.
- **`src/app.ts`** → `createApp()` wires Hono app: CORS middleware → maintenance mode check → route mounting → error handler.

### Types & Package Exports

| Symbol            | Description                                 |
| ----------------- | ------------------------------------------- |
| `LeapifyEnv`      | Hono env type with `Bindings` + `Variables` |
| `LeapifyBindings` | CF bindings (D1, KV, Queue, secrets)        |
| `LeapifyUser`     | Firebase claims + D1 role                   |

| Export           | Entry                | Consumer                   |
| ---------------- | -------------------- | -------------------------- |
| `leapify`        | `src/index.ts`       | Server / CF Worker library |
| `leapify/worker` | `src/worker.ts`      | Standalone CF Worker       |
| `leapify/client` | `src/client/`        | Browser (no server deps)   |
| `leapify/types`  | Type-only re-exports | Any TypeScript consumer    |

Peer dependencies (`hono`, `drizzle-orm`, `@cloudflare/workers-types`) are **not bundled** — consumers must install them.

---

## Critical ADRs

### ADR-001: npm Module + CORS Gate

**Problem:** Frontend teams need a zero-config backend; `/api/` endpoints must not be callable from arbitrary third-party sites.

**Decision:**

- Package exported as `leapify` (server) and `leapify/client` (browser).
- All `/api/*` routes check `Origin` against `allowedOrigins`; requests from unlisted origins receive `403`.
- `GET /health` skips CORS — any external service may ping it.
- All secrets stored server-side in `.env` / `wrangler.toml` secrets.

---

### ADR-002: Cloudflare as Primary Cache Layer

**Problem:** 30k users + Firebase rate limits (~50 QPS) + D1 quota (5M reads/day) would be breached under raw traffic.

**Decision:** Use three Cloudflare cache tiers:

| Tier        | Mechanism              | Use Case                    |
| ----------- | ---------------------- | --------------------------- |
| CF CDN Edge | `Cache-Control` + ETag | `GET /events` list          |
| CF KV       | KV `put` with TTL      | Session tokens              |
| CF KV       | KV `put` with TTL      | Slot availability per event |

```typescript
// Events list — short-lived edge cache with ETag revalidation
const etag = generateETag(events)
if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
c.header('Cache-Control', 'public, max-age=1, stale-while-revalidate=1')
c.header('ETag', etag)
return c.json({ data: events })
```

**Consequences:** D1 reads drop to ~5 QPS on events. Auth cache hit rate >90% under burst load. Survives Firebase outages for cached users.

---

### ADR-003: Contentful as Headless CMS

**Problem:** Event content (descriptions, FAQs, site config) needs non-developer editing without DB migrations.

**Decision:** Store all structured content (events metadata, FAQs, site config) in **Contentful**. The backend fetches from Contentful's REST/GraphQL API and caches results in Cloudflare KV.

**Consequences:** Editors update content without code deploys. Contentful CDN + CF KV double-cache absorbs burst reads. Free tier: 100k API calls/mo, 50GB CDN bandwidth.

---

### ADR-004: Async Email via Cloudflare Queues

**Problem:** Resend API takes 200–500ms — breaks p95 latency budget.

**Decision:** Push email jobs to Queue; consumer Worker calls Resend asynchronously.

**Consequences:** Response time unaffected · 3 auto-retries · DLQ for failures · 2–5s email delay (acceptable).

---

### ADR-005: No API Versioning in URL

**Decision:** Breaking changes = major version in `package.json`, not `/v1/` in URL.

---

### ADR-006: Layered Scraping Prevention

**Problem:** CORS only restricts browsers — raw HTTP clients (`curl`, Python `requests`) bypass it entirely. Public endpoints like `GET /events` are scrapable by anyone. Authenticated mutation endpoints face credential-stuffing and per-account abuse.

**Key insight:** No purely server-side mechanism can cryptographically distinguish a real browser from `curl`. Any token a browser can fetch, `curl` can fetch too. Signed request tokens add friction against naive scrapers only.

**Decision:** Apply a layered defense matched to the actual threat per endpoint class:

| Layer | Mechanism | Scope | Bypassed by |
| ----- | --------- | ----- | ----------- |
| 1 | **CF Bot Fight Mode** (dashboard) | All traffic | Residential proxies |
| 2 | **CF WAF Rate Limiting** (dashboard) | All traffic, pre-Worker | Rotating proxies |
| 3 | **KV IP rate limiting** (middleware) | All routes | Rotating proxies |
| 4 | **Firebase JWT** (existing auth) | Mutation endpoints | Stolen real tokens |
| 5 | **UID-based rate limiting** (KV) | Authenticated routes | Many accounts |
| 6 | **`Referer` header guard** (middleware) | Mutation endpoints | Sophisticated clients |
| 7 | **Cloudflare Turnstile** (client + Worker) | Public GETs, if needed | Human-in-the-loop only |

**Endpoint-specific posture:**

- **`POST /bookmarks`, `POST /events`, etc.** — Firebase JWT is the primary control. Scrapers need a real `@dlsu.edu.ph` account that completed OAuth. Rate limit by `user_id` in KV (not IP) to handle multi-account abuse.
- **`GET /events`, `GET /faqs`** — Public data. IP rate limiting + CF Bot Fight Mode covers automated abuse. If data theft (competitor copying listings) becomes a real concern, add Cloudflare Turnstile on the frontend — the only reliable JS challenge.
- **`GET /health`** — Intentionally open; no restrictions.

**KV rate limit key schema:** `rl:<endpoint>:<identifier>` where identifier is `CF-Connecting-IP` for guests or `user_id` for authenticated requests.

**Recommended limits:**

| Endpoint | Identifier | Limit | Window |
| -------- | ---------- | ----- | ------ |
| `GET /events` | IP | 60 req | 60s |
| `GET /events/:slug/slots` | IP | 120 req | 60s |
| `POST /bookmarks` | user_id | 10 req | 60s |
| `POST /events` (admin) | user_id | 20 req | 60s |

**Consequences:** Layers 1–2 cost nothing and block >90% of bot traffic before the Worker runs. Layer 3 (KV rate limiting) is the primary code-level control — essential to implement. Firebase JWT (Layer 4) makes mutation endpoints already scrape-resistant by design. Turnstile (Layer 7) is only warranted if data scraping becomes an observed operational problem, not preemptively.

---

## Database Schema (Essential)

```sql
-- events: slug (unique), status (draft|queued|published), max_slots, registered_slots
-- users: id (Firebase UID), email, role (user|admin|super_admin)
-- bookmarks: (user_id, event_id) composite PK
-- site_config: key-value for maintenance_mode, registration_globally_open
```

**Indexes:** `events.slug` · `bookmarks.user_id` · `bookmarks.event_id`

---

## Error Codes

| Code                  | HTTP | When                   |
| --------------------- | ---- | ---------------------- |
| `UNAUTHORIZED`        | 401  | Missing/invalid token  |
| `DOMAIN_RESTRICTED`   | 403  | Email not @dlsu.edu.ph |
| `FORBIDDEN`           | 403  | User lacks admin role  |
| `NOT_FOUND`           | 404  | Resource missing       |
| `VALIDATION_ERROR`    | 422  | Zod validation failed  |
| `TOO_MANY_REQUESTS`   | 429  | Rate limit exceeded    |
| `SERVICE_UNAVAILABLE` | 503  | Maintenance mode       |

---

## Testing Requirements

| Type              | Tools                               | Target              |
| ----------------- | ----------------------------------- | ------------------- |
| Unit              | Vitest + mocks                      | >85% lines          |
| Integration       | Hono test client + in-memory SQLite | All auth boundaries |
| Auth verification | Mock Firebase via KV cache seed     | 100% of middleware  |

### Test Setup

Tests live in `/tests`. Global setup (`tests/helpers/setup.ts`) mocks `drizzle-orm/d1` to replace D1 with in-memory `better-sqlite3`, running the actual SQL migration from `/drizzle`.

### Test Helpers

| Helper                              | Signature                                 | Purpose                                              |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `createTestApp()`                   | `() => HonoApp`                           | Hono app + mock KV/env bindings                      |
| `makeTestToken(uid)`                | `(uid: string) => string`                 | Fake JWT that passes middleware's UID extraction     |
| `seedUserInKV(kv, uid, role, dbId)` | `(kv, uid, role, dbId?) => Promise<void>` | Pre-seed cached user to bypass Firebase verification |
| `resetTestDb()`                     | `() => void`                              | Reset in-memory SQLite to a clean migration state    |
| `getTestDb()`                       | `() => DrizzleInstance`                   | Obtain the in-memory SQLite instance                 |

**Critical:** Auth tests must NOT call real Firebase. Always use `makeTestToken` + `seedUserInKV`.

---

## Performance Budget (p95)

| Endpoint                  | Target | Cache                    |
| ------------------------- | ------ | ------------------------ |
| `GET /events`             | <50ms  | CF edge + ETag           |
| `GET /events/:slug/slots` | <20ms  | 5s KV                    |
| `GET /users/me`           | <30ms  | Auth KV cache            |
| `POST /bookmarks`         | <100ms | D1 write                 |
| `POST /events` (admin)    | <200ms | D1 write + KV invalidate |

---

## Success Criteria

- [ ] 30,000 concurrent users without exceeding D1/KV quotas
- [ ] Auth cache hit rate >90% during registration bursts
- [ ] <100ms p95 reads under peak load
- [ ] Email queue processes 10k/min with <5s lag
- [ ] `/api/*` inaccessible from origins not in `allowedOrigins`
- [ ] `/health` publicly accessible for uptime monitors
- [ ] No breaking changes without major version bump
