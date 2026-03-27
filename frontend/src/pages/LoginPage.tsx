import LoginCard from '../components/auth/LoginCard'

function LoginPage() {
  return (
    <main className="bg-body-tertiary min-vh-100 d-flex align-items-center py-5">
      <div className="container">
        <div className="row justify-content-center">
          <LoginCard />
        </div>
      </div>
    </main>
  )
}

export default LoginPage
