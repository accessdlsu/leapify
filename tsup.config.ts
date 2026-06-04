import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))

export default defineConfig([
  // ── npm module entries (ESM + CJS) ──────────────────────────────────────
  {
    entry: [
      'src/index.ts',
      'src/client/index.ts',
      'src/client/types.ts',
      'src/lib/middleware/turnstile-challenge.ts',
    ],
    format: ['esm', 'cjs'],
    dts: false,
    splitting: true,
    treeshake: true,
    clean: true,
    sourcemap: false,
    target: 'es2022',
    external: ['hono', '@cloudflare/workers-types', '@opentelemetry/api'],
    outDir: 'dist',
    tsconfig: 'tsconfig.build.json',
    esbuildOptions(opts) {
      opts.define = {
        ...opts.define,
        __APP_VERSION__: JSON.stringify(pkg.version),
      }
    },
  },

  // ── standalone worker entry (ESM only — CF Workers require ESM) ─────────
  // This builds dist/worker.js, referenced by wrangler.toml main = "dist/worker.js"
  {
    entry: { worker: 'src/worker.ts' },
    format: ['esm'],
    dts: false, // worker.ts is not a public API surface
    splitting: false,
    treeshake: true,
    sourcemap: false,
    target: 'es2022',
    external: ['hono', '@cloudflare/workers-types', '@opentelemetry/api'],
    outDir: 'dist',
    // Bundle everything into one file so wrangler can upload it without
    // needing a bundler step in the consumer's deploy pipeline.
    // Keep the browser guard from src/index.ts from throwing in CF Workers.
    // CF Workers don't define `document` so the guard is fine — but we
    // explicitly mark it as no-side-effects-removal.
    esbuildOptions(opts) {
      opts.platform = 'browser' // CF Workers target
      opts.conditions = ['workerd', 'worker', 'browser']
      opts.define = {
        ...opts.define,
        __APP_VERSION__: JSON.stringify(pkg.version),
      }
    },
  },
])
