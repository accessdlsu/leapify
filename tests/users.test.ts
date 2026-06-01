import { test, expect, describe, beforeEach } from 'vitest'
import { createTestApp } from './helpers/app'
import { resetTestDb, getTestDb } from './helpers/setup'
import { makeTestSession } from './helpers/auth'
import { seedEvent, seedUser } from './helpers/seed'

describe('Users & Bookmarks API', () => {
  let app: ReturnType<typeof createTestApp>['app']
  let env: ReturnType<typeof createTestApp>['env']
  let kv: ReturnType<typeof createTestApp>['kv']
  let userToken: string
  let eventId: string

  beforeEach(async () => {
    resetTestDb()
    ;({ app, env, kv } = createTestApp())
    const db = getTestDb()

    const studentUser = await seedUser(db, {
      betterAuthId: 'student-uid-1',
      email: 'student@dlsu.edu.ph',
      role: 'student',
    })
    userToken = await makeTestSession(db, kv, 'student-uid-1', 'student', studentUser.id)

    const event = await seedEvent(db, { slug: 'e1', status: 'published' })
    eventId = event.id
  })

  test('API-USERS-001: Authenticated user gets their own profile', async () => {
    const res = await app.request('/api/users/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.email).toBe('student@dlsu.edu.ph')
  })

  test('API-USERS-002: Guest gets null profile (not 401)', async () => {
    const res = await app.request('/api/users/me', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data).toBeNull()
  })

  test('API-BOOKMARKS-001: Guest gets empty bookmark list (not 401)', async () => {
    const res = await app.request('/api/users/me/bookmarks', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data).toEqual([])
  })

  test('API-BOOKMARKS-002: Authenticated user bookmark list is initially empty', async () => {
    const res = await app.request('/api/users/me/bookmarks', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data).toHaveLength(0)
  })

  test('API-BOOKMARKS-003: Toggle bookmark ON returns 201', async () => {
    const res = await app.request(`/api/users/me/bookmarks/${eventId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.data.bookmarked).toBe(true)
  })

  test('API-BOOKMARKS-004: Toggle bookmark OFF (already bookmarked) returns 200', async () => {
    await app.request(`/api/users/me/bookmarks/${eventId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)

    const res = await app.request(`/api/users/me/bookmarks/${eventId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.bookmarked).toBe(false)
  })

  test('API-BOOKMARKS-005: Bookmark list contains bookmarked event', async () => {
    await app.request(`/api/users/me/bookmarks/${eventId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)

    const res = await app.request('/api/users/me/bookmarks', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0].event.slug).toBe('e1')
  })

  test('API-BOOKMARKS-006: Explicit DELETE bookmark returns bookmarked:false', async () => {
    await app.request(`/api/users/me/bookmarks/${eventId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)

    const res = await app.request(`/api/users/me/bookmarks/${eventId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.bookmarked).toBe(false)
  })

  test('API-BOOKMARKS-007: Bookmark non-existent event returns 404', async () => {
    const res = await app.request('/api/users/me/bookmarks/nonexistent-id', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    expect(res.status).toBe(404)
  })

  test('API-BOOKMARKS-008: Toggle on event-A does not remove bookmark on event-B (isolation)', async () => {
    // Regression for: toggle WHERE clause matched userId only, not userId+eventId.
    // If user had ANY bookmark, toggling a different event would delete the wrong one.
    const db = getTestDb()
    const eventB = await seedEvent(db, { slug: 'e2', status: 'published' })

    // Bookmark event-A (eventId from beforeEach) and event-B
    await app.request(`/api/users/me/bookmarks/${eventId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    await app.request(`/api/users/me/bookmarks/${eventB.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)

    // Toggle event-B OFF
    const toggleRes = await app.request(`/api/users/me/bookmarks/${eventB.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    expect(toggleRes.status).toBe(200)
    const toggleBody = await toggleRes.json() as any
    expect(toggleBody.data.bookmarked).toBe(false)

    // event-A bookmark must still exist
    const listRes = await app.request('/api/users/me/bookmarks', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${userToken}` },
    }, env)
    const listBody = await listRes.json() as any
    expect(listBody.data).toHaveLength(1)
    expect(listBody.data[0].event.slug).toBe('e1')
  })
})
