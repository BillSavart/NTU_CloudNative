import HeaderAlert from '../components/dashboard/HeaderAlert'
import RealTimeOverview from '../components/dashboard/RealTimeOverview'
import CriticalAlertsPanel from '../components/dashboard/CriticalAlertsPanel'
import AttendanceReport from '../components/dashboard/AttendanceReport'
import '../pages/dashboard.css'

function Dashboard() {
  return (
    <div className="d-flex" style={{ minHeight: '100vh', backgroundColor: '#f4f7f9' }}>
      {/* 左側深藍色導覽列 (Sidebar) */}
      <div className="d-flex flex-column flex-shrink-0 text-white sidebar">
        <ul className="nav nav-pills nav-flush flex-column mb-auto text-center pt-4">
          <li className="nav-item mb-4"><a href="#home" className="nav-link active py-3 text-white"><i className="bi bi-house-door-fill fs-4"></i></a></li>
          <li className="nav-item mb-4"><a href="#calendar" className="nav-link py-3 text-white-50"><i className="bi bi-calendar3 fs-4"></i></a></li>
          <li className="nav-item mb-4"><a href="#clock" className="nav-link py-3 text-white-50"><i className="bi bi-clock-fill fs-4"></i></a></li>
          <li className="nav-item mb-4"><a href="#airplane" className="nav-link py-3 text-white-50"><i className="bi bi-airplane-fill fs-4"></i></a></li>
          <li className="nav-item mb-4"><a href="#send" className="nav-link py-3 text-white-50"><i className="bi bi-send-fill fs-4"></i></a></li>
          <li className="nav-item mb-4"><a href="#edit" className="nav-link py-3 text-white-50"><i className="bi bi-pencil-square fs-4"></i></a></li>
          <li className="nav-item mb-4"><a href="#lock" className="nav-link py-3 text-white-50"><i className="bi bi-lock-fill fs-4"></i></a></li>
          <li className="nav-item mb-4"><a href="#analytics" className="nav-link py-3 text-white-50"><i className="bi bi-bar-chart-line-fill fs-4"></i></a></li>
        </ul>
      </div>

      {/* 右側主內容區 */}
      <div className="flex-grow-1 d-flex flex-column">
        <HeaderAlert count={2} />

        <div className="bg-white border-bottom py-3 px-4 d-flex align-items-center">
          <i className="bi bi-list fs-4 me-3 text-dark"></i>
          <span className="fw-bold text-dark fs-5">出勤管理</span>
        </div>

        <div className="p-4 flex-grow-1">
          <h1 className="h3 fw-bold mb-4 text-dark">2026 年 5 月 20 號</h1>

          <div className="row g-4 align-items-stretch">
            <div className="col-lg-4">
              <RealTimeOverview />
            </div>
            <div className="col-lg-4">
              <CriticalAlertsPanel />
            </div>
            <div className="col-lg-4">
              <AttendanceReport />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
