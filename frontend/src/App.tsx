import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import LoginPage from './pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import Dashboard from './pages/Dashboard'
import DepartmentAnalytics from './pages/DepartmentAnalytics'
import DepartmentEmployees from './pages/DepartmentEmployees'
import ComplianceAlerts from './pages/ComplianceAlerts'
import AttendanceRecords from './pages/AttendanceRecords'
import MyAttendance from './pages/employee/MyAttendance'
import Reports from './pages/employee/Reports'
import { fetchCurrentUser, type CurrentUser } from './services/auth'
import { canAccessManagementReports } from './services/permissions'
import { Navigate, Route, Routes } from 'react-router-dom'

function ManagementRoute({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    fetchCurrentUser()
      .then((user) => {
        if (!cancelled) setCurrentUser(user)
      })
      .catch(() => {
        if (!cancelled) setCurrentUser(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (currentUser === undefined) return null
  if (!currentUser) return <Navigate to="/login" replace />
  if (!canAccessManagementReports(currentUser)) return <Navigate to="/employee/my-attendance" replace />

  return children
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/analytics" element={<ManagementRoute><DepartmentAnalytics /></ManagementRoute>} />
      <Route path="/analytics/departments/:departmentId/employees" element={<ManagementRoute><DepartmentEmployees /></ManagementRoute>} />
      <Route path="/alerts" element={<ComplianceAlerts />} />
      <Route path="/attendance-records" element={<AttendanceRecords />} />
      <Route path="/employee/my-attendance" element={<MyAttendance />} />
      <Route path="/employee/reports" element={<ManagementRoute><Reports /></ManagementRoute>} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export default App
