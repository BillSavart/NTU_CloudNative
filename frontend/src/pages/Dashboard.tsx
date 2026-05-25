import { Link } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'

function Dashboard() {
  return (
    <AppShell title="首頁總覽" subtitle="今日出勤狀態與異常摘要">
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">今日出勤</div>
          <div className="kpi-value">428</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">遲到人數</div>
          <div className="kpi-value">17</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">缺勤人數</div>
          <div className="kpi-value">5</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">超時警示</div>
          <div className="kpi-value danger-text">9</div>
        </div>
      </section>

      <section className="panel-grid">
        <div className="panel-card">
          <h2 className="h6 mb-3">即時刷卡事件</h2>
          <table className="table-clean">
            <thead>
              <tr>
                <th>時間</th>
                <th>員工</th>
                <th>部門</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>09:42:18</td>
                <td>E10352</td>
                <td>FAB_A</td>
                <td>IN</td>
              </tr>
              <tr>
                <td>09:41:55</td>
                <td>E22701</td>
                <td>FAB_C</td>
                <td>OUT</td>
              </tr>
              <tr>
                <td>09:41:43</td>
                <td>E04820</td>
                <td>FAB_B</td>
                <td>IN</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="panel-card">
          <h2 className="h6 mb-3">待處理異常</h2>
          <Link className="alert-link-row" to="/alerts?type=overtime_daily">
            <span>單日超過 12 小時</span>
            <span className="danger-text">6</span>
          </Link>
          <Link className="alert-link-row" to="/alerts?type=overtime_crossday">
            <span>跨日連續超時</span>
            <span className="danger-text">2</span>
          </Link>
          <Link className="alert-link-row" to="/alerts?type=unpaired_access">
            <span>未配對進出紀錄</span>
            <span className="danger-text">1</span>
          </Link>
        </div>
      </section>
    </AppShell>
  )
}

export default Dashboard
