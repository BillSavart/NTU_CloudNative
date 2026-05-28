import LoginPage from './pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import Dashboard from './pages/Dashboard'
import DepartmentAnalytics from './pages/DepartmentAnalytics'
import DepartmentEmployees from './pages/DepartmentEmployees'
import ComplianceAlerts from './pages/ComplianceAlerts'
import MyAttendance from './pages/employee/MyAttendance'
import Reports from './pages/employee/Reports'
import { Navigate, Route, Routes } from 'react-router-dom'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/analytics" element={<DepartmentAnalytics />} />
      <Route path="/analytics/departments/:departmentId/employees" element={<DepartmentEmployees />} />
      <Route path="/alerts" element={<ComplianceAlerts />} />
      <Route path="/employee/my-attendance" element={<MyAttendance />} />
      <Route path="/employee/reports" element={<Reports />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export default App
