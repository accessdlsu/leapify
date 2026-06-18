import { Hono } from 'hono'
import { validator, describeRoute } from 'hono-openapi'
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
organizationsRoute.get(
  '/',
  describeRoute({
    tags: ['Organizations'],
    summary: 'List all organizations',
    security: [],
    responses: { 200: { description: 'List of organizations' } },
  }),
  async (c) => {
  const db = createDb(c.env.DB)
  const data = await db.select().from(organizations)
  return c.json({ data })
})

// POST /organizations — admin only
organizationsRoute.post(
  '/',
  describeRoute({
    tags: ['Organizations'],
    summary: 'Create a new organization (admin)',
    responses: {
      201: { description: 'Organization created' },
      409: { description: 'Organization already exists' },
      422: { description: 'Validation error' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  validator('json', createOrganizationSchema),
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
  describeRoute({
    tags: ['Organizations'],
    summary: 'Update an organization (admin)',
    responses: {
      200: { description: 'Organization updated' },
      404: { description: 'Organization not found' },
      409: { description: 'Organization already exists' },
    },
  }),
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
organizationsRoute.delete(
  '/:id',
  describeRoute({
    tags: ['Organizations'],
    summary: 'Delete an organization (admin)',
    responses: {
      204: { description: 'Organization deleted' },
      404: { description: 'Organization not found' },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const { id } = c.req.param()
  const db = createDb(c.env.DB)

  const [deleted] = await db.delete(organizations).where(eq(organizations.id, id)).returning()

  if (!deleted) throw notFound('Organization')

  return c.body(null, 204)
})
