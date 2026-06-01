import { test, expect, describe, beforeEach } from 'vitest'
import { createTestApp } from './helpers/app'
import { resetTestDb, getTestDb } from './helpers/setup'
import { makeTestSession } from './helpers/auth'
import { seedUser } from './helpers/seed'

describe('Security Boundaries (CORS, Roles, Domains)', () => {
  beforeEach(() => {
    resetTestDb()
  })

  describe('CORS Enforcement (ADR-001)', () => {
    // Spin up an app specifically configured to ONLY allow DLSU domains
    const { app, env } = createTestApp({ allowedOrigins: ['https://dlsu-cso.com'] })

    test('SEC-CORS-001: Blocks malicious Cross-Origin request', async () => {
      const res = await app.request('/api/classes/some-event/slots', {
        method: 'GET',
        headers: { 'Origin': 'https://evil-hacker.com' },
      }, env)
      
      expect(res.status).toBe(403)
      const body = await res.json() as any
      expect(body.error.code).toBe('DOMAIN_RESTRICTED')
    })

    test('SEC-CORS-002: Allows valid Cross-Origin request', async () => {
      const res = await app.request('/api/classes', {
        method: 'GET',
        headers: { 'Origin': 'https://dlsu-cso.com' },
      }, env)
      
      // We expect a 200 (or at least anything not 403)
      expect(res.status).toBe(200)
    })

    test('SEC-CORS-003: Publicly exposes /health even to malicious origins', async () => {
      // The health route MUST completely bypass CORS restrictions for uptime monitors
      const res = await app.request('/health', {
        method: 'GET',
        headers: { 'Origin': 'https://random-uptime-bot.com' },
      }, env)
      
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.data.status).toBe('OK')
    })
  })

  describe('Domain & Role Verification', () => {
    const { app, env, kv } = createTestApp()

    test('SEC-AUTH-001: Student cannot modify Site Config — 403 Forbidden', async () => {
      const db = getTestDb()
      const studentUser = await seedUser(db, {
        betterAuthId: 'student-guy',
        email: 'student@dlsu.edu.ph',
        role: 'student',
      })
      const studentToken = await makeTestSession(db, kv, 'student-guy', 'student', studentUser.id)

      // A student tries to perform an admin capability: modifying Site Configurations
      const res = await app.request('/api/config/maintenance_mode', {
        method: 'PATCH',
        headers: { 
          'Authorization': `Bearer ${studentToken}`,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ value: true }),
      }, env)

      // MUST strictly enforce 403 Forbidden!
      expect(res.status).toBe(403)
      const body = await res.json() as any
      expect(body.error.code).toBe('FORBIDDEN')
    })

    test('SEC-AUTH-002: Allows Admin role to bypass Guard', async () => {
      const db = getTestDb()
      const adminUser = await seedUser(db, {
        betterAuthId: 'admin-guy',
        email: 'admin@dlsu.edu.ph',
        role: 'admin',
      })
      const adminToken = await makeTestSession(db, kv, 'admin-guy', 'admin', adminUser.id)

      const res = await app.request('/api/config/maintenance_mode', {
        method: 'PATCH',
        headers: { 
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ value: true }),
      }, env)

      // 200 OK — they passed the admin guard!
      expect(res.status).toBe(200)
    })
  })
})
