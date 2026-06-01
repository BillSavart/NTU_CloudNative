import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { fetchCurrentUser, logout, type CurrentUser } from '../../services/auth'
import { canAccessManagementReports } from '../../services/permissions'

type AppShellProps = {
  title: string
  subtitle?: string
  headerAction?: ReactNode
  children: ReactNode
}

const navItems = [
  { to: '/dashboard', label: '首頁總覽' },
  { to: '/employee/my-attendance', label: '我的出勤' },
  { to: '/attendance-records', label: '刷卡記錄' },
  { to: '/analytics', label: '部門分析', requiresManagement: true },
  { to: '/alerts', label: '異常合規' },
  { to: '/employee/reports', label: '報表中心', requiresManagement: true },
]

function AppShell({ title, subtitle, headerAction, children }: AppShellProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [now, setNow] = useState(new Date())
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [hasLoadedCurrentUser, setHasLoadedCurrentUser] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // Collapse the mobile drawer whenever the route changes so navigating always
  // returns to the content.
  useEffect(() => {
    setIsSidebarOpen(false)
  }, [location.pathname])

  // Let Escape close the drawer for keyboard users.
  useEffect(() => {
    if (!isSidebarOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSidebarOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isSidebarOpen])

  useEffect(() => {
    let cancelled = false
    fetchCurrentUser()
      .then((user) => {
        if (!cancelled) setCurrentUser(user)
      })
      .catch(() => {
        if (!cancelled) setCurrentUser(null)
      })
      .finally(() => {
        if (!cancelled) setHasLoadedCurrentUser(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const datetimeText = `${now.toLocaleDateString('zh-TW')} ${now.toLocaleDateString('zh-TW', { weekday: 'long' })} ${now.toLocaleTimeString('zh-TW', { hour12: false })}`
  const displayName = currentUser?.displayName?.trim() || currentUser?.username || '訪客'
  const visibleNavItems = navItems.filter((item) => !item.requiresManagement || (hasLoadedCurrentUser && canAccessManagementReports(currentUser)))
  const isActiveNavItem = (to: string) => location.pathname === to || location.pathname.startsWith(`${to}/`)

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
    <div className={`attendance-shell ${isSidebarOpen ? 'sidebar-open' : ''}`}>
      <aside id="attendance-sidebar" className={`attendance-sidebar ${isSidebarOpen ? 'is-open' : ''}`}>
        <div className="attendance-brand-block">
          <div className="attendance-brand-row">
            <div className="attendance-brand">出勤管理</div>
            <button
              className="attendance-sidebar-close"
              type="button"
              aria-label="收合選單"
              onClick={() => setIsSidebarOpen(false)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
              </svg>
            </button>
          </div>
          <div className="attendance-sidebar-user">Hi, {displayName}</div>
        </div>

        <nav className="attendance-nav">
          {visibleNavItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`attendance-nav-item ${isActiveNavItem(item.to) ? 'active' : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <button className="attendance-logout-button" type="button" onClick={handleLogout} disabled={isLoggingOut}>
          {isLoggingOut ? '登出中...' : '登出'}
        </button>
      </aside>

      <button
        className="attendance-backdrop"
        type="button"
        aria-label="關閉選單"
        tabIndex={isSidebarOpen ? 0 : -1}
        onClick={() => setIsSidebarOpen(false)}
      />

      <div className="attendance-main">
        <header className="attendance-header">
          <button
            className="attendance-menu-button"
            type="button"
            aria-label="開啟選單"
            aria-controls="attendance-sidebar"
            aria-expanded={isSidebarOpen}
            onClick={() => setIsSidebarOpen(true)}
          >
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
              <path d="M3 6h16M3 11h16M3 16h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
            </svg>
          </button>
          <div className="attendance-header-title-block">
            <h1 className="attendance-title">{title}</h1>
            {subtitle ? <p className="attendance-subtitle">{subtitle}</p> : null}
          </div>
          <div className="attendance-header-meta">
            {headerAction}
            <div className="attendance-header-datetime">{datetimeText}</div>
          </div>
        </header>
        <main className="attendance-content">{children}</main>
      </div>
    </div>
  )
}

export default AppShell
