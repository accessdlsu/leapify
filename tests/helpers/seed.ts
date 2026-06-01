import { randomUUID } from 'node:crypto'
import { events } from '../../src/db/schema/classes'
import { users } from '../../src/db/schema/users'
import { faqs } from '../../src/db/schema/faqs'
import { themes } from '../../src/db/schema/themes'
import { organizations } from '../../src/db/schema/organizations'

function shortId(len = 8) {
  return randomUUID().replace(/-/g, '').slice(0, len)
}

export async function seedTheme(db: any, overrides: Record<string, any> = {}) {
  const id = randomUUID().replace(/-/g, '')
  const [theme] = await db.insert(themes).values({
    id,
    name: `Test Theme ${shortId()}`,
    path: `/test-theme-${shortId()}`,
    ...overrides,
  }).returning()
  return theme
}

export async function seedOrganization(db: any, overrides: Record<string, any> = {}) {
  const id = randomUUID().replace(/-/g, '')
  const [org] = await db.insert(organizations).values({
    id,
    name: `Test Org ${shortId()}`,
    acronym: `TO${shortId(3)}`.toUpperCase(),
    ...overrides,
  }).returning()
  return org
}

export async function seedEvent(db: any, overrides: Record<string, any> = {}) {
  const id = randomUUID().replace(/-/g, '')
  const [event] = await db.insert(events).values({
    id,
    slug: `test-event-${shortId()}`,
    title: 'Test Event',
    status: 'published',
    ...overrides,
  }).returning()
  return event
}

export async function seedUser(db: any, overrides: Record<string, any> = {}) {
  const [user] = await db.insert(users).values({
    betterAuthId: `ba-${shortId()}`,
    email: `user-${shortId(6)}@dlsu.edu.ph`,
    name: 'Test User',
    role: 'student',
    ...overrides,
  }).returning()
  return user as NonNullable<typeof user>
}

export async function seedFaq(db: any, overrides: Record<string, any> = {}) {
  const [faq] = await db.insert(faqs).values({
    question: `Q ${shortId(6)}`,
    answer: 'A',
    ...overrides,
  }).returning()
  return faq as NonNullable<typeof faq>
}
