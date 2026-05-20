import LoginPage from './pages/LoginPage'
import Dashboard from './pages/Dashboard'
import DepartmentAnalytics from './pages/DepartmentAnalytics'
import ComplianceAlerts from './pages/ComplianceAlerts'
import MyAttendance from './pages/employee/MyAttendance'
import Reports from './pages/employee/Reports'
import { Navigate, Route, Routes } from 'react-router-dom'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/analytics" element={<DepartmentAnalytics />} />
      <Route path="/alerts" element={<ComplianceAlerts />} />
      <Route path="/employee/my-attendance" element={<MyAttendance />} />
      <Route path="/employee/reports" element={<Reports />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export default App
