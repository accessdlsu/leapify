import { test, expect, describe, beforeEach } from 'vitest'
import { createTestApp } from './helpers/app'
import { resetTestDb, getTestDb } from './helpers/setup'
import { makeTestSession } from './helpers/auth'
import { seedFaq, seedUser } from './helpers/seed'

describe('FAQs API', () => {
  let app: ReturnType<typeof createTestApp>['app']
  let env: ReturnType<typeof createTestApp>['env']
  let kv: ReturnType<typeof createTestApp>['kv']
  let adminToken: string
  let activeFaqId: string

  beforeEach(async () => {
    resetTestDb()
    ;({ app, env, kv } = createTestApp())
    const db = getTestDb()

    const adminUser = await seedUser(db, {
      betterAuthId: 'admin-uid',
      email: 'admin@dlsu.edu.ph',
      role: 'admin',
    })
    adminToken = await makeTestSession(db, kv, 'admin-uid', 'admin', adminUser.id)

    const activeFaq = await seedFaq(db, { question: 'Active Q', answer: 'A1' })
    activeFaqId = activeFaq.id
    await seedFaq(db, { question: 'Other Q', answer: 'A2' })
  })

  test('API-FAQS-001: List returns all FAQs', async () => {
    const res = await app.request('/api/faqs', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data).toHaveLength(2)
  })

  test('API-FAQS-002: Admin creates FAQ', async () => {
    const res = await app.request('/api/faqs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: 'New Q?', answer: 'New A' }),
    }, env)
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.data.question).toBe('New Q?')
  })

  test('API-FAQS-003: Missing required field returns 400', async () => {
    const res = await app.request('/api/faqs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ answer: 'forgot the question' }),
    }, env)
    expect(res.status).toBe(400)
  })

  test('API-FAQS-004: Admin updates FAQ', async () => {
    const res = await app.request(`/api/faqs/${activeFaqId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: 'Updated Q?' }),
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.question).toBe('Updated Q?')
  })

  test('API-FAQS-005: Update non-existent FAQ returns 404', async () => {
    const res = await app.request('/api/faqs/does-not-exist', {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: 'X?' }),
    }, env)
    expect(res.status).toBe(404)
  })

  test('API-FAQS-006: Admin soft-deletes FAQ — disappears from list', async () => {
    const res = await app.request(`/api/faqs/${activeFaqId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.deleted).toBe(true)

    // Should no longer appear in the list (KV invalidated by delete handler)
    const listRes = await app.request('/api/faqs', { method: 'GET' }, env)
    const listBody = await listRes.json() as any
    expect(listBody.data).toHaveLength(1)
  })

  test('API-FAQS-007: Delete non-existent FAQ returns 404', async () => {
    const res = await app.request('/api/faqs/does-not-exist', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` },
    }, env)
    expect(res.status).toBe(404)
  })
})
