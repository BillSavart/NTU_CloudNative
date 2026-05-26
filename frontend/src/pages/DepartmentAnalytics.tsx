import { useEffect, useMemo, useState } from 'react'
import AppShell from '../components/layout/AppShell'
import {
  fetchAttendanceDaily,
  fetchComplianceAnomalies,
  fetchDepartmentSummary,
  fetchDepartmentTree,
  type AttendanceDailyItem,
  type DashboardSummary,
  type DepartmentNode,
} from '../services/accessEvents'

type DepartmentRow = {
  departmentId: string
  name: string
  summary: DashboardSummary & { departmentId: string; name: string }
  dailyItems: AttendanceDailyItem[]
  anomalyCount: number
}

function flattenDepartments(nodes: DepartmentNode[]): DepartmentNode[] {
  return nodes.flatMap((node) => [node, ...flattenDepartments(node.children ?? [])])
}

function getDisplayDepartments(nodes: DepartmentNode[]): DepartmentNode[] {
  if (nodes.length === 1 && nodes[0].children.length > 0) {
    return nodes[0].children
  }
  return nodes
}

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return '-'
  }
  return `${value.toFixed(1)}%`
}

function DepartmentAnalytics() {
  const [rows, setRows] = useState<DepartmentRow[]>([])
  const [visibleDepartmentCount, setVisibleDepartmentCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        setLoading(true)
        setError(null)

        const tree = await fetchDepartmentTree()
        const departments = getDisplayDepartments(tree)
        const allVisibleDepartments = flattenDepartments(tree)

        const nextRows = await Promise.all(
          departments.map(async (department) => {
            const [summary, daily, anomalies] = await Promise.all([
              fetchDepartmentSummary(department.departmentId),
              fetchAttendanceDaily(120, department.departmentId),
              fetchComplianceAnomalies(200, department.departmentId),
            ])

            return {
              departmentId: department.departmentId,
              name: department.name,
              summary,
              dailyItems: daily.items,
              anomalyCount: anomalies.total,
            }
          }),
        )

        if (!cancelled) {
          setRows(nextRows)
          setVisibleDepartmentCount(allVisibleDepartments.length)
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
    const allDailyItems = rows.flatMap((row) => row.dailyItems)
    const normalCount = allDailyItems.filter((item) => item.status === '正常').length
    const attendanceRate = allDailyItems.length > 0 ? (normalCount / allDailyItems.length) * 100 : null

    return {
      departmentCount: visibleDepartmentCount ?? rows.length,
      attendanceRate,
      anomalyCount: rows.reduce((total, row) => total + row.anomalyCount, 0),
      employeesInside: rows.reduce((total, row) => total + (row.summary.employeesInside ?? 0), 0),
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
              rows.map((row) => {
                const lateCount = row.dailyItems.filter((item) => item.status === '遲到').length
                const overtimeCount = row.dailyItems.filter((item) => item.status === '超過 12 小時').length
                const normalCount = row.dailyItems.filter((item) => item.status === '正常').length
                const rate = row.dailyItems.length > 0 ? (normalCount / row.dailyItems.length) * 100 : null

                return (
                  <tr key={row.departmentId}>
                    <td>{row.departmentId}</td>
                    <td>{row.summary.knownEmployees}</td>
                    <td>{formatPercent(rate)}</td>
                    <td>{lateCount}</td>
                    <td className={overtimeCount > 0 ? 'danger-text' : undefined}>{overtimeCount}</td>
                    <td>{row.summary.employeesInside}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </section>
    </AppShell>
  )
}

export default DepartmentAnalytics
