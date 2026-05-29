import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { confirmPasswordReset } from '../services/auth'

function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    setError('')

    if (password !== confirmPassword) {
      setError('兩次輸入的密碼不一致')
      return
    }

    setIsSubmitting(true)
    try {
      const result = await confirmPasswordReset(token, password)
      setMessage(result.message)
      setPassword('')
      setConfirmPassword('')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '密碼更新失敗')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="reset-password-title">
        <div className="auth-header">
          <h1 id="reset-password-title">重設密碼</h1>
          <p>請輸入新密碼並再次確認。</p>
        </div>

        {message ? <div className="alert alert-success">{message}</div> : null}
        {error ? <div className="alert alert-danger">{error}</div> : null}
        {!token ? (
          <div className="alert alert-warning">缺少重設密碼 token，請重新產生一次性連結。</div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="auth-field">
              <label className="form-label" htmlFor="newPassword">
                新密碼
              </label>
              <input
                id="newPassword"
                className="form-control form-control-lg"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={6}
                required
              />
            </div>
            <div className="auth-field">
              <label className="form-label" htmlFor="confirmPassword">
                確認新密碼
              </label>
              <input
                id="confirmPassword"
                className="form-control form-control-lg"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                minLength={6}
                required
              />
            </div>
            <button className="btn btn-primary btn-lg w-100" type="submit" disabled={isSubmitting}>
              {isSubmitting ? '更新中...' : '更新密碼'}
            </button>
          </form>
        )}
        <div className="auth-footer small">
          <Link to="/login">回登入頁</Link>
        </div>
      </section>
    </main>
  )
}

export default ResetPasswordPage
