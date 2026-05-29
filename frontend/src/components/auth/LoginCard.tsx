import logo from '../../assets/tsmc_logo.png'
import LoginForm from './LoginForm'

function LoginCard() {
  return (
    <section className="auth-card" aria-labelledby="login-title">
      <div className="auth-header">
        <img src={logo} alt="Company Logo" className="auth-logo" />
        <h1 id="login-title">出勤管理系統</h1>
        <p>登入後查看出勤、異常與報表資料。</p>
      </div>

      <LoginForm />
    </section>
  )
}

export default LoginCard
