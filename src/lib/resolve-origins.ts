import { createDb } from '../db'
import { siteConfig } from '../db/schema/site-config'
import { eq } from 'drizzle-orm'
import type { LeapifyBindings } from '../types'

async function getOriginsFromDb(
  env: Pick<LeapifyBindings, 'DB'>,
): Promise<string[] | null> {
  try {
    const db = createDb(env.DB)
    const row = await db.query.siteConfig.findFirst({
      where: eq(siteConfig.key, 'allowed_origins'),
    })
    if (row) return JSON.parse(row.value) as string[]
  } catch {
    /* D1 unavailable — fall through */
  }
  return null
}

/**
 * Resolve allowed origins using the 3-tier lookup:
 *  1. KV cache (`config:allowed_origins`, 24h TTL)
 *  2. D1 source of truth (`site_config` table, key `allowed_origins`)
 *  3. Static fallback from `ALLOWED_ORIGINS` env var
 *
 * Write-through: D1 misses are cached to KV for subsequent requests.
 */
export async function resolveAllowedOrigins(
  env: LeapifyBindings,
  staticFallback: string[],
): Promise<string[]> {
  const kvValue = (await env.KV.get(
    'config:allowed_origins',
    'json',
  )) as string[] | null
  if (kvValue) return kvValue

  const dbOrigins = await getOriginsFromDb(env)
  if (dbOrigins) {
    await env.KV.put(
      'config:allowed_origins',
      JSON.stringify(dbOrigins),
      { expirationTtl: 86400 },
    )
    return dbOrigins
  }

  return staticFallback
}
