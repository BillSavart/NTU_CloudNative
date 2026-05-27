import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import { type AccessEvent, type DashboardSummary, fetchDashboardSummary, fetchRecentAccessEvents } from '../services/accessEvents'

function formatAverageLatency(summary: DashboardSummary | null) {
  if (!summary) {
    return '-'
  }

  if (typeof summary.avgLatencyMs !== 'number') {
    return '-'
  }

  if (summary.totalEvents > 0 && summary.avgLatencyMs === 0) {
    return '<1.0'
  }

  return summary.avgLatencyMs.toFixed(1)
}

function formatPercent(value: number | null | undefined) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '-'
}

function Dashboard() {
  const [events, setEvents] = useState<AccessEvent[]>([])
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsRefreshing, setEventsRefreshing] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(() => new Set())
  const seenEventIdsRef = useRef<Set<string>>(new Set())
  const highlightTimerRef = useRef<number | null>(null)

  const timeFormatter = useMemo(() => {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        setEventsError(null)
        if (!eventsLoading) setEventsRefreshing(true)

        const [next, nextSummary] = await Promise.all([fetchRecentAccessEvents(10), fetchDashboardSummary()])

        if (!cancelled) {
          const nextIds = next.map((event) => event.requestId).filter(Boolean)
          const newIds = nextIds.filter((id) => !seenEventIdsRef.current.has(id))

          nextIds.forEach((id) => seenEventIdsRef.current.add(id))

          setEvents(next)
          setSummary(nextSummary)
          setLastUpdatedAt(new Date())

          if (newIds.length > 0) {
            setHighlightedIds(new Set(newIds))
            if (highlightTimerRef.current !== null) {
              window.clearTimeout(highlightTimerRef.current)
            }
            highlightTimerRef.current = window.setTimeout(() => {
              setHighlightedIds(new Set())
              highlightTimerRef.current = null
            }, 1500)
          }
        }
      } catch (error) {
        if (!cancelled) setEventsError(error instanceof Error ? error.message : 'Failed to load access events')
      } finally {
        if (!cancelled) setEventsLoading(false)
        if (!cancelled) setEventsRefreshing(false)
      }
    }

    void load()
    const intervalId = window.setInterval(() => {
      void load()
    }, 15000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hrMetrics = summary?.hrMetrics
  const securityMetrics = summary?.securityMetrics
  const topViolationPerson = securityMetrics?.topViolationPeople[0]
  const topLateDepartment = hrMetrics?.topLateDepartment

  return (
    <AppShell title="首頁總覽" subtitle="今日出勤狀態與異常摘要">
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">即時出勤率</div>
          <div className="kpi-value">{formatPercent(hrMetrics?.attendanceRate)}</div>
          <div className="kpi-footnote">
            {hrMetrics ? `${hrMetrics.attendedToday}/${hrMetrics.expectedToday} 今日已進廠` : '今日應到 / 實到'}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Anti-Passback 違規</div>
          <div className="kpi-value danger-text">{securityMetrics?.antiPassbackViolations ?? '-'}</div>
          <div className="kpi-footnote">
            {topViolationPerson ? `${topViolationPerson.displayName ?? topViolationPerson.employeeId} ${topViolationPerson.count} 次` : '近 24 小時'}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">目前在廠</div>
          <div className="kpi-value">{summary?.employeesInside ?? '-'}</div>
          <div className="kpi-footnote">last known state = IN</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">目前不在廠</div>
          <div className="kpi-value">{summary?.employeesOutside ?? '-'}</div>
          <div className="kpi-footnote">已知員工 - 在廠</div>
        </div>
      </section>

      <section className="panel-grid">
        <div className="panel-card">
          <div className="d-flex align-items-center justify-content-between mb-2">
            <h2 className="h6 mb-0">即時刷卡事件</h2>
            <div className="small text-secondary">
              {eventsRefreshing ? '更新中…' : lastUpdatedAt ? `更新於 ${timeFormatter.format(lastUpdatedAt)}` : null}
            </div>
          </div>
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
              {eventsLoading ? (
                <tr>
                  <td colSpan={4} className="text-secondary">
                    載入中…
                  </td>
                </tr>
              ) : eventsError ? (
                <tr>
                  <td colSpan={4} className="text-danger">
                    {eventsError}
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-secondary">
                    目前沒有刷卡事件
                  </td>
                </tr>
              ) : (
                events.map((event) => {
                  const occurredAt = new Date(event.timestamp)
                  const timeText = Number.isNaN(occurredAt.getTime()) ? '-' : timeFormatter.format(occurredAt)
                  const employeeText = event.displayName?.trim() ? event.displayName : event.employeeId
                  return (
                    <tr key={event.requestId} className={highlightedIds.has(event.requestId) ? 'table-row-new' : undefined}>
                      <td>{timeText}</td>
                      <td>{employeeText}</td>
                      <td>{event.departmentId ?? '-'}</td>
                      <td>{event.direction}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="panel-card">
          <h2 className="h6 mb-3">HR 與安全熱區</h2>
          <Link className="alert-link-row" to="/analytics">
            <span>遲到最高部門</span>
            <span className={topLateDepartment ? 'danger-text' : undefined}>
              {topLateDepartment ? `${topLateDepartment.key} ${topLateDepartment.count}` : '-'}
            </span>
          </Link>
          <Link className="alert-link-row" to="/alerts?type=overtime_daily">
            <span>過勞警示名單</span>
            <span className="danger-text">{hrMetrics?.overtimeAlertCount ?? '-'}</span>
          </Link>
          <Link className="alert-link-row" to="/alerts?type=denied_access">
            <span>拒絕通行事件</span>
            <span className="danger-text">{summary?.deniedEvents ?? '-'}</span>
          </Link>
          <div className="alert-link-row dashboard-static-row">
            <span>平均延遲 ms</span>
            <span className="danger-text">{formatAverageLatency(summary)}</span>
          </div>
        </div>
      </section>

      <section className="dashboard-insight-grid">
        <div className="panel-card">
          <h2 className="h6 mb-3">過勞紅燈</h2>
          <div className="dashboard-list">
            {hrMetrics?.overtimeAlerts.length ? (
              hrMetrics.overtimeAlerts.map((item) => (
                <div className="dashboard-list-row" key={`${item.employeeId}-${item.date ?? item.occurredAt ?? ''}`}>
                  <span>{item.displayName ?? item.employeeId}</span>
                  <strong>{typeof item.workHours === 'number' ? `${item.workHours.toFixed(1)}h` : `${item.consecutiveDays ?? '-'} 天`}</strong>
                </div>
              ))
            ) : (
              <div className="text-secondary">目前沒有單日超過 12 小時警示</div>
            )}
          </div>
        </div>

        <div className="panel-card">
          <h2 className="h6 mb-3">Anti-Passback 人員</h2>
          <div className="dashboard-list">
            {securityMetrics?.topViolationPeople.length ? (
              securityMetrics.topViolationPeople.map((item) => (
                <div className="dashboard-list-row" key={item.employeeId}>
                  <span>{item.displayName ?? item.employeeId}</span>
                  <strong>{item.count} 次</strong>
                </div>
              ))
            ) : (
              <div className="text-secondary">近 24 小時沒有防潛回違規</div>
            )}
          </div>
        </div>

      </section>
    </AppShell>
  )
}

export default Dashboard
