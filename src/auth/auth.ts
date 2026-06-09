import { betterAuth } from 'better-auth/minimal'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer } from 'better-auth/plugins'
import { count } from 'drizzle-orm'
import { createDb } from '../db'
import {
  authUser,
  authSession,
  authAccount,
  authVerification
} from '../db/schema/auth'
import { users } from '../db/schema/users'
import type { LeapifyBindings } from '../types'

const DLSU_DOMAIN = '@dlsu.edu.ph'

function extractHosts(origins: string[]): string[] {
  return origins
    .map(origin => {
      try { return new URL(origin).host } catch { return null }
    })
    .filter((h): h is string => h !== null)
}

/**
 * Creates a request-scoped Better Auth instance.
 *
 * Must be a factory (not a module singleton) because CF Workers D1
 * bindings are only available at request time, not at module init.
 *
 * Features:
 *  - Drizzle SQLite adapter backed by D1
 *  - bearer() plugin: supports Authorization: Bearer <token> alongside cookies
 *  - Google social provider (for GIS One Tap credential flow)
 *  - databaseHooks enforces @dlsu.edu.ph domain server-side
 *  - After successful user creation, upserts a row in our custom `users` table
 *    to carry the application role
 *  - Dynamic baseURL: derives OAuth callback origin from X-Forwarded-Host,
 *    enabling same-origin auth for frontend Workers that proxy auth requests.
 *
 * @param resolvedOrigins - Allowed origins resolved via the 3-tier lookup
 *   (KV → D1 → ALLOWED_ORIGINS). Hostnames are extracted from these URLs
 *   and used as Better Auth's allowedHosts for dynamic baseURL.
 */
export function createAuth(env: LeapifyBindings, resolvedOrigins?: string[]) {
  const db = createDb(env.DB)
  const allowedHosts = extractHosts(resolvedOrigins ?? [])

  return betterAuth({
    baseURL: allowedHosts.length > 0
      ? {
          allowedHosts,
          fallback: env.BETTER_AUTH_URL,
          protocol: 'auto',
        }
      : env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,

    advanced: {
      trustedProxyHeaders: allowedHosts.length > 0,
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'],
      },
    },

    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification
      }
    }),

    plugins: [bearer()],

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        hd: env.GOOGLE_HD || undefined
      }
    },

    databaseHooks: {
      user: {
        create: {
          /**
           * Runs before the Better Auth `user` row is inserted.
           * Reject non-DLSU accounts before they ever touch the DB.
           */
          before: async (user) => {
            if (!user.email.endsWith(DLSU_DOMAIN)) {
              // Throwing here causes Better Auth to return 403 to the client
              throw new Error(
                'DOMAIN_RESTRICTED: only @dlsu.edu.ph accounts are allowed'
              )
            }
            return { data: user }
          },

          /**
           * Runs after the Better Auth `user` row is created.
           * Upsert a matching row in our application `users` table so that
           * the role column and D1 foreign keys are always consistent.
           *
           * The very first user to sign in is automatically promoted to
           * `super_admin` so the platform has an administrator from day one.
           */
          after: async (user) => {
            const [{ total }] = await db.select({ total: count() }).from(users)
            const isFirstUser = total === 0

            const base = {
              betterAuthId: user.id,
              email: user.email,
              name: user.name ?? user.email.split('@')[0],
              role: isFirstUser ? 'super_admin' as const : 'student' as const,
            }

            if (isFirstUser) {
              // Atomic: insert as super_admin, or update existing row (created
              // by the resolveUser race) to super_admin.
              await db
                .insert(users)
                .values(base)
                .onConflictDoUpdate({
                  target: users.email,
                  set: {
                    betterAuthId: user.id,
                    role: 'super_admin',
                    name: user.name ?? user.email.split('@')[0],
                  },
                })
            } else {
              await db
                .insert(users)
                .values(base)
                .onConflictDoUpdate({
                  target: users.email,
                  set: {
                    betterAuthId: user.id,
                    name: user.name ?? user.email.split('@')[0],
                  },
                })
            }
          }
        }
      }
    }
  })
}

export type { Auth } from 'better-auth/types'
