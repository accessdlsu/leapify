import { test, expect, describe, beforeEach } from 'vitest'
import { createTestApp } from './helpers/app'
import { resetTestDb, getTestDb } from './helpers/setup'
import { makeTestSession } from './helpers/auth'
import { seedEvent, seedUser } from './helpers/seed'

describe('Events API', () => {
  let app: ReturnType<typeof createTestApp>['app']
  let env: ReturnType<typeof createTestApp>['env']
  let kv: ReturnType<typeof createTestApp>['kv']
  let adminToken: string
  let userToken: string

  beforeEach(async () => {
    resetTestDb()
    ;({ app, env, kv } = createTestApp())
    const db = getTestDb()

    const adminUser = await seedUser(db, {
      betterAuthId: 'admin-uid-1',
      email: 'admin@dlsu.edu.ph',
      role: 'admin',
    })
    adminToken = await makeTestSession(db, kv, 'admin-uid-1', 'admin', adminUser.id)

    const studentUser = await seedUser(db, {
      betterAuthId: 'user-uid-1',
      email: 'student@dlsu.edu.ph',
      role: 'student',
    })
    userToken = await makeTestSession(db, kv, 'user-uid-1', 'student', studentUser.id)

    await seedEvent(db, { slug: 'published-event', status: 'published' })
    await seedEvent(db, { slug: 'draft-event', status: 'draft' })
  })

  test('API-EVENTS-001: List published events returns only published', async () => {
    const res = await app.request('/events', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('max-age=604800')
    expect(res.headers.get('ETag')).not.toBeNull()
    const body = await res.json() as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0].slug).toBe('published-event')
  })

  test('API-EVENTS-002: 304 on ETag match', async () => {
    const first = await app.request('/events', { method: 'GET' }, env)
    const etag = first.headers.get('ETag')!

    const second = await app.request('/events', {
      method: 'GET',
      headers: { 'If-None-Match': etag },
    }, env)
    expect(second.status).toBe(304)
  })

  test('API-EVENTS-003: Draft event slug returns 404', async () => {
    const res = await app.request('/events/draft-event', { method: 'GET' }, env)
    const text = await res.text()
    console.log('API-EVENTS-003 RESPONSE HTML:', text)
    expect(res.status).toBe(404)
  })

  test('API-EVENTS-004: Get published event by slug', async () => {
    const res = await app.request('/events/published-event', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.slug).toBe('published-event')
  })

  test('API-EVENTS-005: Non-existent slug returns 404', async () => {
    const res = await app.request('/events/does-not-exist', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })

  test('API-EVENTS-006: Slots endpoint with Cache-Control header', async () => {
    const res = await app.request('/events/published-event/slots', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=5, stale-while-revalidate=5')
    const body = await res.json() as any
    expect(typeof body.data.available).toBe('number')
    expect(typeof body.data.total).toBe('number')
  })

  test('API-EVENTS-007: Slots for non-existent event returns 404', async () => {
    const res = await app.request('/events/ghost/slots', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })

  test('API-EVENTS-008: Admin can create an event', async () => {
    const res = await app.request('/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'brand-new-event',
        categoryName: 'ACM',
        categoryPath: '/acm',
        title: 'Brand New Event',
      }),
    }, env)
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.data.slug).toBe('brand-new-event')
  })

  test('API-EVENTS-009: Missing required fields returns 400', async () => {
    const res = await app.request('/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ categoryName: 'ACM' }),
    }, env)
    expect(res.status).toBe(400)
  })

  test('API-EVENTS-010: Admin can update an event', async () => {
    const res = await app.request('/events/published-event', {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Updated Title' }),
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.title).toBe('Updated Title')
  })

  test('API-EVENTS-011: PATCH non-existent event returns 404', async () => {
    const res = await app.request('/events/ghost-event', {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Updated' }),
    }, env)
    expect(res.status).toBe(404)
  })

  test('API-EDGE-AUTH-001: Guest on protected route returns 401', async () => {
    const res = await app.request('/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'x', categoryName: 'X', categoryPath: '/x', title: 'X' }),
    }, env)
    expect(res.status).toBe(401)
  })

  test('API-EDGE-AUTH-002: Student token on admin route returns 403', async () => {
    const res = await app.request('/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ slug: 'x', categoryName: 'X', categoryPath: '/x', title: 'X' }),
    }, env)
    expect(res.status).toBe(403)
  })
})
