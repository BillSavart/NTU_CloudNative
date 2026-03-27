import { useState } from 'react'
import type { FormEvent } from 'react'
import { login } from '../../services/auth'

function LoginForm() {
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSuccess('')
    setIsSubmitting(true)

    try {
      const result = await login({ employeeId, password })
      setSuccess(result.message)
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : '登入失敗'
      setError(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {error ? <div className="alert alert-danger">{error}</div> : null}
      {success ? <div className="alert alert-success">{success}</div> : null}

      <div className="mb-3">
        <label htmlFor="employeeId" className="form-label fw-semibold">
          員工編號
        </label>
        <input
          id="employeeId"
          type="text"
          className="form-control form-control-lg"
          placeholder="例如：A12345"
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
          required
        />
      </div>

      <div className="mb-4">
        <label htmlFor="password" className="form-label fw-semibold">
          密碼
        </label>
        <input
          id="password"
          type="password"
          className="form-control form-control-lg"
          placeholder="請輸入密碼"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>

      <div className="d-grid gap-2 mb-3">
        <button type="submit" className="btn btn-primary btn-lg fw-semibold" disabled={isSubmitting}>
          {isSubmitting ? '登入中...' : '登入系統'}
        </button>
      </div>

      <div className="d-flex justify-content-between align-items-center small">
        <div className="form-check">
          <input className="form-check-input" type="checkbox" id="remember" />
          <label className="form-check-label" htmlFor="remember">
            記住我
          </label>
        </div>
        <a href="#" className="link-primary text-decoration-none">
          忘記密碼？
        </a>
      </div>
    </form>
  )
}

export default LoginForm
