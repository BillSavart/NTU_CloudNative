import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { fetchCurrentUser, logout, type CurrentUser } from '../../services/auth'

type AppShellProps = {
  title: string
  subtitle?: string
  children: ReactNode
}

const navItems = [
  { to: '/dashboard', label: '首頁總覽' },
  { to: '/employee/my-attendance', label: '我的出勤' },
  { to: '/analytics', label: '部門分析' },
  { to: '/alerts', label: '異常合規' },
  { to: '/employee/reports', label: '報表中心' },
]

function AppShell({ title, subtitle, children }: AppShellProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [now, setNow] = useState(new Date())
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

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

  const datetimeText = `${now.toLocaleDateString('zh-TW')} ${now.toLocaleDateString('zh-TW', { weekday: 'long' })} ${now.toLocaleTimeString('zh-TW', { hour12: false })}`
  const displayName = currentUser?.displayName?.trim() || currentUser?.username || '訪客'

  const handleLogout = async () => {
    setIsLoggingOut(true)
    try {
      await logout()
    } finally {
      setCurrentUser(null)
      setIsLoggingOut(false)
      navigate('/login', { replace: true })
    }
  }

  return (
    <div className="attendance-shell">
      <aside className="attendance-sidebar">
        <div className="attendance-brand-block">
          <div className="attendance-brand">出勤管理</div>
          <div className="attendance-sidebar-user">Hi, {displayName}</div>
        </div>

        <nav className="attendance-nav">
          {navItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`attendance-nav-item ${location.pathname === item.to ? 'active' : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <button className="attendance-logout-button" type="button" onClick={handleLogout} disabled={isLoggingOut}>
          {isLoggingOut ? '登出中...' : '登出'}
        </button>
      </aside>

      <div className="attendance-main">
        <header className="attendance-header">
          <div>
            <h1 className="attendance-title">{title}</h1>
            {subtitle ? <p className="attendance-subtitle">{subtitle}</p> : null}
          </div>
          <div className="attendance-header-meta">
            <div className="attendance-header-datetime">{datetimeText}</div>
          </div>
        </header>
        <main className="attendance-content">{children}</main>
      </div>
    </div>
  )
}

export default AppShell
