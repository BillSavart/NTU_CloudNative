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
    <main className="bg-body-tertiary min-vh-100 d-flex align-items-center py-5">
      <div className="container">
        <div className="row justify-content-center">
          <div className="col-12 col-sm-10 col-md-8 col-lg-5">
            <div className="card border-0 shadow-lg rounded-4">
              <div className="card-body p-4 p-md-5">
                <h1 className="h4 mb-3">重設密碼</h1>
                {message ? <div className="alert alert-success">{message}</div> : null}
                {error ? <div className="alert alert-danger">{error}</div> : null}
                {!token ? (
                  <div className="alert alert-warning">缺少重設密碼 token，請重新產生一次性連結。</div>
                ) : (
                  <form onSubmit={handleSubmit}>
                    <div className="mb-3">
                      <label className="form-label fw-semibold" htmlFor="newPassword">
                        新密碼
                      </label>
                      <input
                        id="newPassword"
                        className="form-control form-control-lg"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        minLength={6}
                        required
                      />
                    </div>
                    <div className="mb-4">
                      <label className="form-label fw-semibold" htmlFor="confirmPassword">
                        確認新密碼
                      </label>
                      <input
                        id="confirmPassword"
                        className="form-control form-control-lg"
                        type="password"
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
                <div className="mt-3 small">
                  <Link to="/login">回登入頁</Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}

export default ResetPasswordPage
