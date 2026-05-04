import { defineConfig } from 'tsup'

export default defineConfig([
  // ── npm module entries (ESM + CJS) ──────────────────────────────────────
  {
    entry: [
      'src/index.ts',
      'src/client/index.ts',
      'src/client/types.ts',
      'src/lib/middleware/pow-challenge.ts',
    ],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: true,
    treeshake: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
    external: ['hono', '@cloudflare/workers-types'],
    outDir: 'dist',
    tsconfig: 'tsconfig.build.json',
  },

  // ── standalone worker entry (ESM only — CF Workers require ESM) ─────────
  // This builds dist/worker.js, referenced by wrangler.toml main = "dist/worker.js"
  {
    entry: { worker: 'src/worker.ts' },
    format: ['esm'],
    dts: false, // worker.ts is not a public API surface
    splitting: false,
    treeshake: true,
    sourcemap: true,
    target: 'es2022',
    external: ['hono', '@cloudflare/workers-types'],
    outDir: 'dist',
    // Bundle everything into one file so wrangler can upload it without
    // needing a bundler step in the consumer's deploy pipeline.
    noExternal: [/.*/],
    // Keep the browser guard from src/index.ts from throwing in CF Workers.
    // CF Workers don't define `document` so the guard is fine — but we
    // explicitly mark it as no-side-effects-removal.
    esbuildOptions(opts) {
      opts.platform = 'browser' // CF Workers target
      opts.conditions = ['workerd', 'worker', 'browser']
    },
  },
])
