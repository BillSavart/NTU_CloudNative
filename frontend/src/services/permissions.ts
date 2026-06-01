import type { CurrentUser } from './auth'

const MANAGEMENT_ROLES = new Set(['ADMIN', 'EXECUTIVE', 'MANAGER'])

export function canAccessManagementReports(user: CurrentUser | null | undefined): boolean {
  if (!user) return false
  if (user.role && MANAGEMENT_ROLES.has(user.role)) return true
  return user.isStaff === true && user.role !== 'EMPLOYEE'
}
