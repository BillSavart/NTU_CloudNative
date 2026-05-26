import { useEffect, useMemo, useState } from 'react'
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
        const result = await fetchDepartmentAnalytics(7)
        if (!cancelled) {
          setRows(result.departments)
          setVisibleDepartmentCount(result.visibleDepartmentCount)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load department analytics')
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
      anomalyCount: rows.reduce((total, row) => total + row.overtimeRecords, 0),
      employeesInside: rows.reduce((total, row) => total + row.employeesInside, 0),
    }
  }, [rows, visibleDepartmentCount])

  return (
    <AppShell title="部門分析" subtitle="轄下部門出勤比較與趨勢">
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">轄下部門數</div>
          <div className="kpi-value">{loading ? '-' : metrics.departmentCount}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">近期正常率</div>
          <div className="kpi-value">{loading ? '-' : formatPercent(metrics.attendanceRate)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">超時異常總數</div>
          <div className="kpi-value danger-text">{loading ? '-' : metrics.anomalyCount}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">目前在廠人數</div>
          <div className="kpi-value">{loading ? '-' : metrics.employeesInside}</div>
        </div>
      </section>

      <section className="panel-card">
        <h2 className="h6 mb-3">部門比較</h2>
        <table className="table-clean">
          <thead>
            <tr>
              <th>部門</th>
              <th>員工數</th>
              <th>近期正常率</th>
              <th>遲到</th>
              <th>超時</th>
              <th>目前在廠</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="text-secondary">
                  載入中…
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={6} className="text-danger">
                  {error}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-secondary">
                  目前沒有可檢視的部門資料
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.departmentId}>
                  <td>{row.departmentId}</td>
                  <td>{row.knownEmployees}</td>
                  <td>{formatPercent(normalRate(row))}</td>
                  <td>{row.lateRecords}</td>
                  <td className={row.overtimeRecords > 0 ? 'danger-text' : undefined}>{row.overtimeRecords}</td>
                  <td>{row.employeesInside}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </AppShell>
  )
}

export default DepartmentAnalytics
