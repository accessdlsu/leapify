import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer } from 'better-auth/plugins'
import { createDb } from '../db'
import { users } from '../db/schema/users'
import type { LeapifyBindings } from '../types'

const DLSU_DOMAIN = '@dlsu.edu.ph'

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
 */
export function createAuth(env: LeapifyBindings) {
  const db = createDb(env.DB)

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(db, { provider: 'sqlite' }),

    plugins: [bearer()],

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
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
              throw new Error('DOMAIN_RESTRICTED: only @dlsu.edu.ph accounts are allowed')
            }
            return { data: user }
          },

          /**
           * Runs after the Better Auth `user` row is created.
           * Upsert a matching row in our application `users` table so that
           * the role column and D1 foreign keys are always consistent.
           */
          after: async (user) => {
            await db
              .insert(users)
              .values({
                betterAuthId: user.id,
                email: user.email,
                name: user.name ?? user.email.split('@')[0],
              })
              .onConflictDoNothing({ target: users.betterAuthId })
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
