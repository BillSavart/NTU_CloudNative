import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { login, requestPasswordReset } from '../../services/auth'
import { useNavigate } from 'react-router-dom'

const REMEMBERED_LOGIN_KEY = 'attendance.rememberedLogin'

function readRememberedLogin() {
  try {
    return window.localStorage?.getItem(REMEMBERED_LOGIN_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeRememberedLogin(value: string, shouldRemember: boolean) {
  try {
    if (shouldRemember) {
      window.localStorage?.setItem(REMEMBERED_LOGIN_KEY, value)
    } else {
      window.localStorage?.removeItem(REMEMBERED_LOGIN_KEY)
    }
  } catch {
    // Browser storage may be unavailable in private or test environments.
  }
}

function LoginForm() {
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [isResetOpen, setIsResetOpen] = useState(false)
  const [resetLoginId, setResetLoginId] = useState('')
  const [resetEmail, setResetEmail] = useState('')
  const [resetLink, setResetLink] = useState('')
  const [isResetSubmitting, setIsResetSubmitting] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    const remembered = readRememberedLogin()
    if (remembered) {
      setEmployeeId(remembered)
      setRememberMe(true)
    }
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSuccess('')
    setIsSubmitting(true)

    try {
      const result = await login({ employeeId, password, rememberMe })
      writeRememberedLogin(employeeId, rememberMe)
      setSuccess(result.message)
      navigate(result.user?.isStaff === false ? '/employee/my-attendance' : '/dashboard', { replace: true })
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : '登入失敗'
      setError(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleResetSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSuccess('')
    setResetLink('')
    setIsResetSubmitting(true)

    try {
      const result = await requestPasswordReset(resetLoginId, resetEmail)
      setSuccess(result.message)
      if (result.resetLink) {
        setResetLink(result.resetLink)
      }
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : '重設密碼連結產生失敗')
    } finally {
      setIsResetSubmitting(false)
    }
  }

  const navigate = useNavigate()

  return (
    <>
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? <div className="alert alert-danger mb-0">{error}</div> : null}
        {success ? <div className="alert alert-success mb-0">{success}</div> : null}

        <div className="auth-field">
          <label htmlFor="employeeId" className="form-label">
            登入帳號
          </label>
          <input
            id="employeeId"
            type="text"
            className="form-control form-control-lg"
            placeholder="例如：employee 或 fab_1_manager"
            autoComplete="username"
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            required
          />
        </div>

        <div className="auth-field">
          <label htmlFor="password" className="form-label">
            密碼
          </label>
          <input
            id="password"
            type="password"
            className="form-control form-control-lg"
            placeholder="請輸入密碼"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <button type="submit" className="btn btn-primary btn-lg w-100" disabled={isSubmitting}>
          {isSubmitting ? '登入中...' : '登入系統'}
        </button>

        <div className="auth-actions">
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="remember"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
            />
            <label className="form-check-label" htmlFor="remember">
              記住我
            </label>
          </div>
          <button
            className="auth-link-button"
            type="button"
            onClick={() => {
              setIsResetOpen((current) => !current)
              setResetLoginId(employeeId)
              setResetLink('')
            }}
          >
            忘記密碼？
          </button>
        </div>

      </form>

      {isResetOpen ? (
        <form className="auth-reset-panel" onSubmit={handleResetSubmit}>
          <h2>重設密碼</h2>
          <div className="auth-field">
            <label htmlFor="resetLoginId" className="form-label">
              登入帳號
            </label>
            <input
              id="resetLoginId"
              type="text"
              className="form-control"
              value={resetLoginId}
              onChange={(event) => setResetLoginId(event.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <label htmlFor="resetEmail" className="form-label">
              Email
            </label>
            <input
              id="resetEmail"
              type="email"
              className="form-control"
              placeholder="例如：employee@demo.local"
              value={resetEmail}
              onChange={(event) => setResetEmail(event.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn btn-outline-primary w-100" disabled={isResetSubmitting}>
            {isResetSubmitting ? '產生中...' : '產生一次性更改密碼連結'}
          </button>
          {resetLink ? (
            <div className="auth-reset-link small">
              一次性連結：
              <div>
                <a href={resetLink}>
                {resetLink}
                </a>
              </div>
            </div>
          ) : null}
        </form>
      ) : null}
    </>
  )
}

export default LoginForm
