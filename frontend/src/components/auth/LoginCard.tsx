import logo from '../../assets/tsmc_logo.png'
import LoginForm from './LoginForm'

function LoginCard() {
  return (
    <div className="col-12 col-sm-10 col-md-8 col-lg-5">
      <div className="card border-0 shadow-lg rounded-4">
        <div className="card-body p-4 p-md-5">
          <div className="text-center mb-4">
            <img src={logo} alt="Company Logo" className="img-fluid mb-3 w-25" />
            <h1 className="h3 fw-bold mb-2">出勤管理系統</h1>
            <p className="text-secondary mb-0">請登入以查看與管理員工出勤資料</p>
          </div>

          <LoginForm />
        </div>
      </div>
    </div>
  )
}

export default LoginCard
