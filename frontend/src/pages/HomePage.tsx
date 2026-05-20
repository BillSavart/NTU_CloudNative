import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

function HomePage() {
  const [user, setUser] = useState<{ username?: string } | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    async function fetchMe() {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
        if (!res.ok) throw new Error('未取得使用者資訊')
        const data = await res.json()
        setUser(data.user || null)
      } catch (err) {
        setUser(null)
      }
    }

    fetchMe()
  }, [])

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    navigate('/login', { replace: true })
  }

  return (
    <main className="container py-5">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h1 className="h3">系統首頁</h1>
        <div>
          <button className="btn btn-outline-secondary" onClick={handleLogout}>
            登出
          </button>
        </div>
      </div>

      <div className="card p-4">
        <h2 className="h5">歡迎</h2>
        <p>{user ? `使用者：${user.username}` : '載入使用者資訊...'}</p>
        <p>這是登入後的簡單首頁範例，您可以在此擴充系統功能或導向其他頁面。</p>
      </div>
    </main>
  )
}

export default HomePage
