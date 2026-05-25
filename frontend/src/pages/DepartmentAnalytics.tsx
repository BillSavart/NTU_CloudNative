import AppShell from '../components/layout/AppShell'

function DepartmentAnalytics() {
  return (
    <AppShell title="部門分析" subtitle="轄下部門出勤比較與趨勢">
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">轄下部門數</div>
          <div className="kpi-value">3</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">平均出勤率</div>
          <div className="kpi-value">94.2%</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">本週異常總數</div>
          <div className="kpi-value danger-text">14</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">今日在廠人數</div>
          <div className="kpi-value">217</div>
        </div>
      </section>

      <section className="panel-card">
        <h2 className="h6 mb-3">部門比較</h2>
        <table className="table-clean">
          <thead>
            <tr>
              <th>部門</th>
              <th>到班率</th>
              <th>遲到</th>
              <th>缺勤</th>
              <th>超時</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>FAB_A</td>
              <td>95.1%</td>
              <td>5</td>
              <td>1</td>
              <td className="danger-text">3</td>
            </tr>
            <tr>
              <td>FAB_B</td>
              <td>93.8%</td>
              <td>7</td>
              <td>2</td>
              <td className="danger-text">5</td>
            </tr>
            <tr>
              <td>FAB_C</td>
              <td>93.6%</td>
              <td>5</td>
              <td>2</td>
              <td className="danger-text">6</td>
            </tr>
          </tbody>
        </table>
      </section>
    </AppShell>
  )
}

export default DepartmentAnalytics
