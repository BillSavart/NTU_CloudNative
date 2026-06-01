import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import { fetchDepartmentAnalytics, type DepartmentAnalyticsRow } from '../services/accessEvents'

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return '-'
  }
  return `${value.toFixed(1)}%`
}

function normalRate(row: DepartmentAnalyticsRow) {
  if (row.dailyRecords <= 0) {
    return null
  }
  return (row.normalRecords / row.dailyRecords) * 100
}

function DepartmentAnalytics() {
  const [rows, setRows] = useState<DepartmentAnalyticsRow[]>([])
  const [visibleDepartmentCount, setVisibleDepartmentCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        const result = await fetchDepartmentAnalytics(31)
        if (!cancelled) {
          setRows(result.departments)
          setVisibleDepartmentCount(result.visibleDepartmentCount)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : '無法載入部門分析資料')
          setRows([])
          setVisibleDepartmentCount(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const metrics = useMemo(() => {
    const dailyRecords = rows.reduce((total, row) => total + row.dailyRecords, 0)
    const normalRecords = rows.reduce((total, row) => total + row.normalRecords, 0)

    return {
      departmentCount: visibleDepartmentCount ?? rows.length,
      attendanceRate: dailyRecords > 0 ? (normalRecords / dailyRecords) * 100 : null,
      anomalyCount: rows.reduce((total, row) => total + row.overtimeRecords + row.lateRecords, 0),
      employeesInside: rows.reduce((total, row) => total + row.employeesInside, 0),
    }
  }, [rows, visibleDepartmentCount])

  return (
    <AppShell title="部門分析" subtitle="以主管視角追蹤轄下部門的人力狀態、出勤品質與異常風險">
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">可見部門</div>
          <div className="kpi-value">{loading ? '-' : metrics.departmentCount}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">本月正常出勤率</div>
          <div className="kpi-value">{loading ? '-' : formatPercent(metrics.attendanceRate)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">本月出勤異常</div>
          <div className="kpi-value danger-text">{loading ? '-' : metrics.anomalyCount}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">目前在廠人數</div>
          <div className="kpi-value">{loading ? '-' : metrics.employeesInside}</div>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-heading-row">
          <div>
            <h2 className="h6 mb-1">部門概況</h2>
            <p className="panel-helper-text">點選查看員工可進一步檢視本月工時、異常次數與即時在廠狀態。</p>
          </div>
        </div>
        <div className="table-responsive">
          <table className="table-clean">
            <thead>
              <tr>
                <th>部門</th>
                <th>員工數</th>
                <th>正常出勤率</th>
                <th>遲到</th>
                <th>超時</th>
                <th>在廠</th>
                <th>管理</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="text-secondary">
                    載入中...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={7} className="text-danger">
                    {error}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-secondary">
                    目前沒有可檢視的部門資料
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.departmentId}>
                    <td>
                      <strong>{row.name || row.departmentId}</strong>
                      <div className="table-subtext">{row.departmentId}</div>
                    </td>
                    <td>{row.knownEmployees}</td>
                    <td>{formatPercent(normalRate(row))}</td>
                    <td className={row.lateRecords > 0 ? 'warning-text' : undefined}>{row.lateRecords}</td>
                    <td className={row.overtimeRecords > 0 ? 'danger-text' : undefined}>{row.overtimeRecords}</td>
                    <td>{row.employeesInside}</td>
                    <td>
                      <Link
                        className="table-action-link"
                        to={`/analytics/departments/${encodeURIComponent(row.departmentId)}/employees`}
                      >
                        查看員工
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  )
}

export default DepartmentAnalytics
