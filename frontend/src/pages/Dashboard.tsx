import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import { type AccessEvent, fetchRecentAccessEvents } from '../services/accessEvents'

function Dashboard() {
  const [events, setEvents] = useState<AccessEvent[]>([])
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

        const next = await fetchRecentAccessEvents(10)

        if (!cancelled) {
          const nextIds = next.map((event) => event.requestId).filter(Boolean)
          const newIds = nextIds.filter((id) => !seenEventIdsRef.current.has(id))

          nextIds.forEach((id) => seenEventIdsRef.current.add(id))

          setEvents(next)
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
    }, 5000)

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
