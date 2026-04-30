import { randomUUID } from 'node:crypto'
import { events } from '../../src/db/schema/events'
import { users } from '../../src/db/schema/users'
import { faqs } from '../../src/db/schema/faqs'

function shortId(len = 8) {
  return randomUUID().replace(/-/g, '').slice(0, len)
}

export async function seedEvent(db: any, overrides: Record<string, any> = {}) {
  const [event] = await db.insert(events).values({
    slug: `test-event-${shortId()}`,
    categoryName: 'Test Category',
    categoryPath: 'test',
    title: 'Test Event',
    status: 'published',
    isMajor: false,
    maxSlots: 100,
    registeredSlots: 0,
    ...overrides,
  }).returning()
  return event as NonNullable<typeof event>
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
    isActive: true,
    ...overrides,
  }).returning()
  return faq as NonNullable<typeof faq>
}
