import { describe, expect, it } from 'vitest'

import { canAccessManagementReports } from './permissions'
import type { CurrentUser } from './auth'

function user(overrides: Partial<CurrentUser>): CurrentUser {
  return {
    username: 'user',
    isStaff: false,
    ...overrides,
  }
}

describe('canAccessManagementReports', () => {
  it('denies regular employees', () => {
    expect(canAccessManagementReports(user({ role: 'EMPLOYEE', isStaff: false }))).toBe(false)
  })

  it('allows managers and higher roles', () => {
    expect(canAccessManagementReports(user({ role: 'MANAGER', isStaff: true }))).toBe(true)
    expect(canAccessManagementReports(user({ role: 'EXECUTIVE', isStaff: true }))).toBe(true)
    expect(canAccessManagementReports(user({ role: 'ADMIN', isStaff: true }))).toBe(true)
  })

  it('denies anonymous users', () => {
    expect(canAccessManagementReports(null)).toBe(false)
  })
})
