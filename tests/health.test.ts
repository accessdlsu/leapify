import { test, expect } from 'vitest'
import { createTestApp } from './helpers/app'
import { resetTestDb } from './helpers/setup'

test('API-HEALTH-001: Health check endpoint', async () => {
  resetTestDb()
  const { app, env } = createTestApp()
  const res = await app.request('/health', { method: 'GET' }, env)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toMatchObject({ data: { status: 'OK' } })
})
