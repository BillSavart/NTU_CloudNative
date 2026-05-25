import AppShell from '../../components/layout/AppShell'

function MyAttendance() {
  return (
    <AppShell title="我的出勤" subtitle="個人上下班紀錄與工時摘要">
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">本月出勤天數</div>
          <div className="kpi-value">16</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">準時率</div>
          <div className="kpi-value">96%</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">本月總工時</div>
          <div className="kpi-value">148h</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">異常筆數</div>
          <div className="kpi-value danger-text">1</div>
        </div>
      </section>

      <section className="panel-card">
        <h2 className="h6 mb-3">近期出勤明細</h2>
        <table className="table-clean">
          <thead>
            <tr>
              <th>日期</th>
              <th>上班</th>
              <th>下班</th>
              <th>工時</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>2026-05-25</td>
              <td>08:58</td>
              <td>18:12</td>
              <td>9.2h</td>
              <td>正常</td>
            </tr>
            <tr>
              <td>2026-05-24</td>
              <td>09:03</td>
              <td>18:05</td>
              <td>9.0h</td>
              <td>正常</td>
            </tr>
            <tr>
              <td>2026-05-23</td>
              <td>08:48</td>
              <td>21:14</td>
              <td className="danger-text">12.4h</td>
              <td className="danger-text">超時</td>
            </tr>
          </tbody>
        </table>
      </section>
    </AppShell>
  )
}

export default MyAttendance
