import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { themes } from '../db/schema/themes'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { notFound, conflict } from '../lib/errors'

const createThemeSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  color: z.string().optional(),
})

export const themesRoute = new Hono<LeapifyEnv>()

// GET /themes — public
themesRoute.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const data = await db.select().from(themes)
  return c.json({ data })
})

// POST /themes — admin only
themesRoute.post(
  '/',
  authMiddleware,
  adminMiddleware,
  zValidator('json', createThemeSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = createDb(c.env.DB)

    try {
      const [created] = await db.insert(themes).values(body).returning()
      return c.json({ data: created }, 201)
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw conflict('A theme with this name or path already exists.')
      }
      throw err
    }
  },
)

// PATCH /themes/:id — admin only
themesRoute.patch(
  '/:id',
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const { id } = c.req.param()
    const body = await c.req.json<Partial<z.infer<typeof createThemeSchema>>>()
    const db = createDb(c.env.DB)

    try {
      const [updated] = await db
        .update(themes)
        .set(body)
        .where(eq(themes.id, id))
        .returning()

      if (!updated) throw notFound('Theme')

      return c.json({ data: updated })
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw conflict('A theme with this name or path already exists.')
      }
      throw err
    }
  },
)

// DELETE /themes/:id — admin only
themesRoute.delete('/:id', authMiddleware, adminMiddleware, async (c) => {
  const { id } = c.req.param()
  const db = createDb(c.env.DB)

  const [deleted] = await db.delete(themes).where(eq(themes.id, id)).returning()

  if (!deleted) throw notFound('Theme')

  return c.body(null, 204)
})
