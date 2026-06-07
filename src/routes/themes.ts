import { Hono } from 'hono'
import { validator, describeRoute } from 'hono-openapi'
import { z } from 'zod'
import { eq, asc } from 'drizzle-orm'
import type { LeapifyEnv } from '../types'
import { createDb } from '../db'
import { themes } from '../db/schema/themes'
import { authMiddleware, adminMiddleware } from '../auth/middleware'
import { notFound, conflict } from '../lib/errors'

function generatePath(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const createThemeSchema = z.object({
  name: z.string().min(1),
  imageUrl: z.string().url().nullable().optional(),
  descriptionEn: z.string().nullable().optional(),
  descriptionFil: z.string().nullable().optional(),
  sortOrder: z.number().int().default(0),
})

const patchThemeSchema = z.object({
  name: z.string().min(1).optional(),
  imageUrl: z.string().url().nullable().optional(),
  descriptionEn: z.string().nullable().optional(),
  descriptionFil: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
})

export const themesRoute = new Hono<LeapifyEnv>()

// GET /themes — public
themesRoute.get(
  '/',
  describeRoute({
    tags: ['Themes'],
    summary: 'List all themes',
    responses: { 200: { description: 'List of themes' } },
  }),
  async (c) => {
  const db = createDb(c.env.DB)
  const data = await db.select().from(themes).orderBy(asc(themes.sortOrder), asc(themes.createdAt))
  const serialized = data.map(({ sortOrder, ...rest }) => rest)
  return c.json({ data: serialized })
})

// POST /themes — admin only
themesRoute.post(
  '/',
  describeRoute({
    tags: ['Themes'],
    summary: 'Create a new theme (admin)',
    responses: {
      201: { description: 'Theme created' },
      409: { description: 'Theme already exists' },
      422: { description: 'Validation error' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  validator('json', createThemeSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = createDb(c.env.DB)
    const path = generatePath(body.name)
    try {
      const [created] = await db.insert(themes).values({ ...body, path }).returning()
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
  describeRoute({
    tags: ['Themes'],
    summary: 'Update a theme (admin)',
    responses: {
      200: { description: 'Theme updated' },
      404: { description: 'Theme not found' },
      409: { description: 'Theme already exists' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const { id } = c.req.param()
    const body = await c.req.json<z.infer<typeof patchThemeSchema>>()
    const db = createDb(c.env.DB)
    const update: Record<string, unknown> = { ...body }
    if (body.name) {
      update.path = generatePath(body.name)
    }
    try {
      const [updated] = await db
        .update(themes)
        .set(update)
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
themesRoute.delete(
  '/:id',
  describeRoute({
    tags: ['Themes'],
    summary: 'Delete a theme (admin)',
    responses: {
      204: { description: 'Theme deleted' },
      404: { description: 'Theme not found' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const { id } = c.req.param()
  const db = createDb(c.env.DB)
  const [deleted] = await db.delete(themes).where(eq(themes.id, id)).returning()
  if (!deleted) throw notFound('Theme')
  return c.body(null, 204)
})
