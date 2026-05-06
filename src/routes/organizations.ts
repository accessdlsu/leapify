import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { organizations } from '../db/schema/organizations'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { notFound, conflict } from '../lib/errors'

const createOrganizationSchema = z.object({
  name: z.string().min(1),
  acronym: z.string().min(1),
  logoUrl: z.string().url().nullable().optional(),
  link: z.string().url().nullable().optional(),
})

export const organizationsRoute = new Hono<LeapifyEnv>()

// GET /organizations — public
organizationsRoute.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const data = await db.select().from(organizations)
  return c.json({ data })
})

// POST /organizations — admin only
organizationsRoute.post(
  '/',
  authMiddleware,
  adminMiddleware,
  zValidator('json', createOrganizationSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = createDb(c.env.DB)

    try {
      const [created] = await db.insert(organizations).values(body).returning()
      return c.json({ data: created }, 201)
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw conflict('An organization with this name or acronym already exists.')
      }
      throw err
    }
  },
)

// PATCH /organizations/:id — admin only
organizationsRoute.patch(
  '/:id',
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const { id } = c.req.param()
    const body = await c.req.json<Partial<z.infer<typeof createOrganizationSchema>>>()
    const db = createDb(c.env.DB)

    try {
      const [updated] = await db
        .update(organizations)
        .set(body)
        .where(eq(organizations.id, id))
        .returning()

      if (!updated) throw notFound('Organization')

      return c.json({ data: updated })
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw conflict('An organization with this name or acronym already exists.')
      }
      throw err
    }
  },
)

// DELETE /organizations/:id — admin only
organizationsRoute.delete('/:id', authMiddleware, adminMiddleware, async (c) => {
  const { id } = c.req.param()
  const db = createDb(c.env.DB)

  const [deleted] = await db.delete(organizations).where(eq(organizations.id, id)).returning()

  if (!deleted) throw notFound('Organization')

  return c.body(null, 204)
})
