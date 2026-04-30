import { test, expect, describe, beforeEach } from 'vitest'
import { createTestApp } from './helpers/app'
import { resetTestDb, getTestDb } from './helpers/setup'
import { makeTestSession } from './helpers/auth'
import { seedUser } from './helpers/seed'
import { siteConfig } from '../src/db/schema/site-config'

describe('Site Config API', () => {
  let app: ReturnType<typeof createTestApp>['app']
  let env: ReturnType<typeof createTestApp>['env']
  let kv: ReturnType<typeof createTestApp>['kv']
  let adminToken: string

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

    await db.insert(siteConfig).values({
      key: 'coming_soon_until',
      value: '1700000000',
    })
  })

  test('API-CONFIG-001: GET /config returns structured config with defaults', async () => {
    const res = await app.request('/config', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.comingSoonUntil).toBe(1700000000)
    expect(body.data.registrationGloballyOpen).toBe(true)
    expect(body.data.maintenanceMode).toBe(false)
    expect(body.data.siteEndsAt).toBeNull()
    expect(typeof body.data.now).toBe('number')
  })

  test('API-CONFIG-002: Admin can update a config key (upsert)', async () => {
    const res = await app.request('/config/site_ends_at', {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: 1800000000 }),
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.key).toBe('site_ends_at')
    expect(body.data.value).toBe(1800000000)

    const checkRes = await app.request('/config', { method: 'GET' }, env)
    const checkBody = await checkRes.json() as any
    expect(checkBody.data.siteEndsAt).toBe(1800000000)
  })

  test('API-CONFIG-003: Guest cannot update config — returns 401', async () => {
    const res = await app.request('/config/site_ends_at', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    }, env)
    expect(res.status).toBe(401)
  })
})
