import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
const defines = { __APP_VERSION__: JSON.stringify(pkg.version) }

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
    outExtensions: ({ format }) => ({
      js: format === 'es' ? '.js' : '.cjs',
    }),
    dts: false,
    treeshake: true,
    sourcemap: false,
    target: 'es2022',
    outDir: 'dist',
    tsconfig: 'tsconfig.build.json',
    deps: {
      neverBundle: ['@opentelemetry/api'],
    },
    define: defines,
  },

  // ── standalone worker entry (ESM only — CF Workers require ESM) ─────────
  // This builds dist/worker.js, referenced by wrangler.toml main = "dist/worker.js"
  {
    entry: { worker: 'src/worker.ts' },
    format: ['esm'],
    dts: false, // worker.ts is not a public API surface
    treeshake: true,
    sourcemap: false,
    target: 'es2022',
    deps: {
      neverBundle: ['hono', '@cloudflare/workers-types', '@opentelemetry/api'],
    },
    outDir: 'dist',
    platform: 'browser',
    define: defines,
  },
])
