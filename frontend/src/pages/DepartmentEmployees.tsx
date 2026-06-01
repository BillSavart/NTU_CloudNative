import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import {
  fetchDepartmentEmployeeMetrics,
  type DepartmentEmployeeMetric,
  type DepartmentEmployeeMetricsResponse,
} from '../services/accessEvents'

function formatHours(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '-'
  }
  return `${value.toFixed(1)}h`
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return '-'
  }
  return new Date(value).toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function stateLabel(state: DepartmentEmployeeMetric['lastKnownState']) {
  if (state === 'IN') return '在廠'
  // OUT and the default UNKNOWN are both treated as not in the factory, matching
  // the backend which counts UNKNOWN employees as "outside".
  return '不在廠'
}

function stateClassName(state: DepartmentEmployeeMetric['lastKnownState']) {
  if (state === 'IN') return 'status-pill status-pill-in'
  return 'status-pill status-pill-out'
}

const PAGE_SIZE = 50

function DepartmentEmployees() {
  const { departmentId = '' } = useParams()
  const [data, setData] = useState<DepartmentEmployeeMetricsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        const result = await fetchDepartmentEmployeeMetrics(departmentId, PAGE_SIZE, offset)
        if (!cancelled) setData(result)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : '無法載入員工名單')
          setData(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    if (departmentId) {
      void load()
    }
    return () => {
      cancelled = true
    }
  }, [departmentId, offset])

  const highAttentionCount = useMemo(() => {
    return data?.items.filter((employee) => employee.monthlyAnomalyCount >= 2 || (employee.averageDailyHours ?? 0) > 10).length ?? 0
  }, [data])

  const subtitle = data
    ? `${data.name} (${data.departmentId}) 本月人力與出勤狀態`
    : '檢視部門員工的即時狀態、本月工時與異常紀錄'

  return (
    <AppShell
      title="員工名單"
      subtitle={subtitle}
      headerAction={
        <Link className="secondary-action-link" to="/analytics">
          返回部門分析
        </Link>
      }
    >
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">部門員工</div>
          <div className="kpi-value">{loading ? '-' : data?.summary.totalEmployees ?? 0}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">目前在廠</div>
          <div className="kpi-value">{loading ? '-' : data?.summary.insideCount ?? 0}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">本月總工時</div>
          <div className="kpi-value">{loading ? '-' : formatHours(data?.summary.totalMonthlyWorkHours)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">需關注人員</div>
          <div className="kpi-value danger-text">{loading ? '-' : highAttentionCount}</div>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-heading-row">
          <div>
            <h2 className="h6 mb-1">本月員工指標</h2>
            <p className="panel-helper-text">
              指標聚焦主管排班與人力風險：即時在廠狀態、累積工時、平均日工時、遲到、超時與拒絕刷卡。
            </p>
          </div>
        </div>
        {!loading && !error && data && data.total > PAGE_SIZE && (
          <div className="d-flex justify-content-between align-items-center mb-2 small text-secondary">
            <span>第 {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} 筆，共 {data.total} 筆</span>
            <div className="d-flex gap-2">
              <button
                className="btn btn-sm btn-outline-secondary"
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >← 上一頁</button>
              <button
                className="btn btn-sm btn-outline-secondary"
                type="button"
                disabled={offset + PAGE_SIZE >= data.total}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >下一頁 →</button>
            </div>
          </div>
        )}
        <div className="table-responsive">
          <table className="table-clean employee-metrics-table">
            <thead>
              <tr>
                <th>員工</th>
                <th>狀態</th>
                <th>本月工時</th>
                <th>出勤天數</th>
                <th>平均日工時</th>
                <th>遲到</th>
                <th>超時</th>
                <th>拒絕刷卡</th>
                <th>異常總數</th>
                <th>最後刷卡</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10} className="text-secondary">
                    載入中...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={10} className="text-danger">
                    {error}
                  </td>
                </tr>
              ) : !data || data.items.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-secondary">
                    此部門目前沒有員工資料
                  </td>
                </tr>
              ) : (
                data.items.map((employee) => (
                  <tr key={employee.employeeId}>
                    <td>
                      <strong>{employee.displayName || employee.employeeId}</strong>
                      <div className="table-subtext">{employee.employeeId}</div>
                    </td>
                    <td>
                      <span className={stateClassName(employee.lastKnownState)}>{stateLabel(employee.lastKnownState)}</span>
                    </td>
                    <td>{formatHours(employee.monthlyWorkHours)}</td>
                    <td>{employee.monthlyAttendanceDays}</td>
                    <td>{formatHours(employee.averageDailyHours)}</td>
                    <td className={employee.monthlyLateCount > 0 ? 'warning-text' : undefined}>{employee.monthlyLateCount}</td>
                    <td className={employee.monthlyOvertimeCount > 0 ? 'danger-text' : undefined}>
                      {employee.monthlyOvertimeCount}
                    </td>
                    <td className={employee.monthlyDeniedCount > 0 ? 'danger-text' : undefined}>
                      {employee.monthlyDeniedCount}
                    </td>
                    <td className={employee.monthlyAnomalyCount > 0 ? 'danger-text' : undefined}>
                      {employee.monthlyAnomalyCount}
                    </td>
                    <td>{formatDateTime(employee.lastSeenAt)}</td>
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

export default DepartmentEmployees
