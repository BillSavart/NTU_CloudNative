import { useEffect, useMemo, useState } from 'react'
import AppShell from '../../components/layout/AppShell'
import { fetchAttendanceDaily, type AttendanceDailyItem } from '../../services/accessEvents'

function formatTime(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function MyAttendance() {
  const [items, setItems] = useState<AttendanceDailyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchAttendanceDaily(31)
      .then((result) => {
        if (!cancelled) setItems(result.items)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '載入失敗')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const summary = useMemo(() => {
    const worked = items.filter((item) => item.firstIn && item.lastOut)
    const normal = worked.filter((item) => item.status === '正常').length
    const totalHours = worked.reduce((sum, item) => sum + (item.workHours ?? 0), 0)
    const anomalies = items.filter((item) => item.status !== '正常').length
    return {
      workedDays: worked.length,
      onTimeRate: worked.length > 0 ? Math.round((normal / worked.length) * 100) : 0,
      totalHours,
      anomalies,
    }
  }, [items])

  return (
    <AppShell title="我的出勤" subtitle="個人上下班紀錄與工時摘要">
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">近期出勤天數</div>
          <div className="kpi-value">{loading ? '-' : summary.workedDays}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">準時率</div>
          <div className="kpi-value">{loading ? '-' : `${summary.onTimeRate}%`}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">近期總工時</div>
          <div className="kpi-value">{loading ? '-' : `${summary.totalHours.toFixed(1)}h`}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">異常筆數</div>
          <div className="kpi-value danger-text">{loading ? '-' : summary.anomalies}</div>
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
            {loading ? (
              <tr><td colSpan={5} className="text-secondary">載入中...</td></tr>
            ) : error ? (
              <tr><td colSpan={5} className="text-danger">{error}</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="text-secondary">目前沒有出勤資料</td></tr>
            ) : (
              items.map((item) => (
                <tr key={`${item.employeeId}-${item.date}`}>
                  <td>{item.date}</td>
                  <td>{formatTime(item.firstIn)}</td>
                  <td>{formatTime(item.lastOut)}</td>
                  <td className={(item.workHours ?? 0) > 12 ? 'danger-text' : undefined}>
                    {item.workHours == null ? '-' : `${item.workHours.toFixed(1)}h`}
                  </td>
                  <td className={item.status === '正常' ? undefined : 'danger-text'}>{item.status}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </AppShell>
  )
}

export default MyAttendance
