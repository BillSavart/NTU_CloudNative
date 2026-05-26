import { useEffect, useMemo, useState } from 'react'
import AppShell from '../../components/layout/AppShell'
import {
  type AccessEvent,
  type DepartmentNode,
  fetchAccessEvents,
  fetchDashboardSummary,
  fetchDepartmentTree,
} from '../../services/accessEvents'

type DownloadContent = 'raw' | 'visual'

type ReportMetrics = {
  total: number
  granted: number
  denied: number
  inCount: number
  outCount: number
  avgLatencyMs: number | null
  deniedRate: number
  topDepartments: Array<{ departmentId: string; count: number }>
  hourlyActivity: Array<{ hour: string; count: number }>
}

type DepartmentOption = {
  departmentId: string
  name: string
  depth: number
}

function localDateInputValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function defaultFromDate() {
  const date = new Date()
  date.setDate(date.getDate() - 7)
  return localDateInputValue(date)
}

function csvEscape(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

function htmlEscape(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? '' : String(value)
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function flattenDepartments(nodes: DepartmentNode[], depth = 0): DepartmentOption[] {
  return nodes.flatMap((node) => [
    { departmentId: node.departmentId, name: node.name, depth },
    ...flattenDepartments(node.children ?? [], depth + 1),
  ])
}

function summarizeEvents(events: AccessEvent[]): ReportMetrics {
  const departmentCounts = new Map<string, number>()
  const hourlyCounts = new Map<string, number>()
  let granted = 0
  let denied = 0
  let inCount = 0
  let outCount = 0
  let latencyTotal = 0
  let latencySamples = 0

  for (const event of events) {
    if (event.decision === 'GRANTED') granted += 1
    if (event.decision === 'DENIED') denied += 1
    if (event.direction === 'IN') inCount += 1
    if (event.direction === 'OUT') outCount += 1
    if (Number.isFinite(event.latencyMs)) {
      latencyTotal += event.latencyMs
      latencySamples += 1
    }

    const departmentId = event.departmentId || 'UNKNOWN'
    departmentCounts.set(departmentId, (departmentCounts.get(departmentId) ?? 0) + 1)

    const timestamp = new Date(event.timestamp)
    const hour = Number.isNaN(timestamp.getTime()) ? '--' : String(timestamp.getHours()).padStart(2, '0')
    hourlyCounts.set(hour, (hourlyCounts.get(hour) ?? 0) + 1)
  }

  return {
    total: events.length,
    granted,
    denied,
    inCount,
    outCount,
    avgLatencyMs: latencySamples > 0 ? Math.round(latencyTotal / latencySamples) : null,
    deniedRate: events.length > 0 ? denied / events.length : 0,
    topDepartments: [...departmentCounts.entries()]
      .map(([departmentId, count]) => ({ departmentId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    hourlyActivity: [...hourlyCounts.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
  }
}

function toCsv(events: AccessEvent[]) {
  const headers = [
    'requestId',
    'employeeId',
    'displayName',
    'departmentId',
    'gateId',
    'direction',
    'decision',
    'reason',
    'previousState',
    'currentState',
    'latencyMs',
    'timestamp',
    'consumedAt',
  ]

  const rows = events.map((event) =>
    [
      event.requestId,
      event.employeeId,
      event.displayName,
      event.departmentId,
      event.gateId,
      event.direction,
      event.decision,
      event.reason,
      event.previousState,
      event.currentState,
      event.latencyMs,
      event.timestamp,
      event.consumedAt,
    ]
      .map(csvEscape)
      .join(','),
  )

  return [headers.join(','), ...rows].join('\n')
}

function metricLine(label: string, value: string | number) {
  return `<div class="metric"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong></div>`
}

function barRows(items: Array<{ label: string; value: number }>) {
  const max = Math.max(1, ...items.map((item) => item.value))
  return items
    .map(
      (item) => `
        <div class="bar-row">
          <span>${htmlEscape(item.label)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, (item.value / max) * 100)}%"></div></div>
          <strong>${htmlEscape(item.value)}</strong>
        </div>
      `,
    )
    .join('')
}

function buildVisualReport(events: AccessEvent[], metrics: ReportMetrics, from: string, to: string, departmentId: string) {
  const generatedAt = new Date().toLocaleString('zh-TW', { hour12: false })
  const deptPart = departmentId === 'ALL' ? '全部部門' : departmentId
  const rows =
    events.length > 0
      ? events
          .slice(0, 80)
          .map(
            (event) => `
              <tr>
                <td>${htmlEscape(new Date(event.timestamp).toLocaleString('zh-TW', { hour12: false }))}</td>
                <td>${htmlEscape(event.employeeId)}</td>
                <td>${htmlEscape(event.displayName)}</td>
                <td>${htmlEscape(event.departmentId)}</td>
                <td>${htmlEscape(event.gateId)}</td>
                <td>${htmlEscape(event.direction)}</td>
                <td>${htmlEscape(event.decision)}</td>
                <td>${htmlEscape(event.reason)}</td>
              </tr>
            `,
          )
          .join('')
      : '<tr><td colspan="8" class="empty">此條件目前沒有事件資料。</td></tr>'

  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <title>出勤圖形化報表</title>
    <style>
      body { color: #172033; font-family: Arial, "Noto Sans TC", sans-serif; margin: 28px; }
      h1 { font-size: 24px; margin: 0 0 8px; }
      h2 { font-size: 16px; margin: 24px 0 10px; }
      .meta { color: #5f6b7a; font-size: 12px; margin-bottom: 18px; }
      .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
      .metric { border: 1px solid #cfd6df; border-radius: 8px; padding: 10px; }
      .metric span { color: #5f6b7a; display: block; font-size: 12px; }
      .metric strong { color: #0f2742; display: block; font-size: 22px; margin-top: 6px; }
      .chart { border: 1px solid #cfd6df; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
      .bar-row { align-items: center; display: grid; gap: 10px; grid-template-columns: 92px 1fr 52px; margin: 8px 0; }
      .bar-track { background: #edf2f7; border-radius: 999px; height: 10px; overflow: hidden; }
      .bar-fill { background: #1d6f8f; height: 100%; }
      table { border-collapse: collapse; font-size: 10px; width: 100%; }
      th, td { border: 1px solid #cfd6df; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #edf2f7; color: #253044; }
      .empty { color: #5f6b7a; padding: 18px; text-align: center; }
      @media print { body { margin: 14mm; } .metrics { grid-template-columns: repeat(2, 1fr); } }
    </style>
  </head>
  <body>
    <h1>出勤圖形化報表</h1>
    <div class="meta">期間：${htmlEscape(from)} 至 ${htmlEscape(to)} | 範圍：${htmlEscape(deptPart)} | 產生時間：${htmlEscape(generatedAt)}</div>
    <div class="metrics">
      ${metricLine('事件總數', metrics.total)}
      ${metricLine('允許通行', metrics.granted)}
      ${metricLine('拒絕通行', metrics.denied)}
      ${metricLine('拒絕率', `${(metrics.deniedRate * 100).toFixed(1)}%`)}
      ${metricLine('刷進', metrics.inCount)}
      ${metricLine('刷出', metrics.outCount)}
      ${metricLine('平均延遲', metrics.avgLatencyMs === null ? '-' : `${metrics.avgLatencyMs} ms`)}
      ${metricLine('預覽筆數', events.length)}
    </div>
    <h2>部門事件分布</h2>
    <div class="chart">${barRows(metrics.topDepartments.map((item) => ({ label: item.departmentId, value: item.count })))}</div>
    <h2>時段活動量</h2>
    <div class="chart">${barRows(metrics.hourlyActivity.map((item) => ({ label: `${item.hour}:00`, value: item.count })))}</div>
    <h2>事件明細預覽</h2>
    <table>
      <thead>
        <tr>
          <th>時間</th>
          <th>員工編號</th>
          <th>姓名</th>
          <th>部門</th>
          <th>門禁</th>
          <th>方向</th>
          <th>結果</th>
          <th>原因</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <script>
      window.addEventListener('load', () => {
        setTimeout(() => window.print(), 250)
      })
    </script>
  </body>
</html>`
}

function Reports() {
  const [from, setFrom] = useState(defaultFromDate)
  const [to, setTo] = useState(() => localDateInputValue(new Date()))
  const [departmentId, setDepartmentId] = useState('ALL')
  const [downloadContent, setDownloadContent] = useState<DownloadContent>('visual')
  const [events, setEvents] = useState<AccessEvent[]>([])
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOption[]>([])
  const [companyTotalEvents, setCompanyTotalEvents] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isDownloading, setIsDownloading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setMessage(null)

    Promise.all([
      fetchAccessEvents({
        from,
        to,
        departmentId,
        limit: 500,
        offset: 0,
      }),
      fetchDepartmentTree(),
      fetchDashboardSummary(),
    ])
      .then(([eventResult, departments, dashboard]) => {
        if (cancelled) return
        setEvents(eventResult.events)
        setDepartmentOptions(flattenDepartments(departments))
        setCompanyTotalEvents(dashboard.totalEvents)
      })
      .catch((error) => {
        if (cancelled) return
        setEvents([])
        setMessage(error instanceof Error ? error.message : '報表資料載入失敗')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [departmentId, from, to])

  const metrics = useMemo(() => summarizeEvents(events), [events])
  const maxDepartmentCount = Math.max(1, ...metrics.topDepartments.map((item) => item.count))
  const maxHourlyCount = Math.max(1, ...metrics.hourlyActivity.map((item) => item.count))

  const downloadReport = async () => {
    setIsDownloading(true)
    setMessage(null)

    try {
      const result = await fetchAccessEvents({
        from,
        to,
        departmentId,
        limit: downloadContent === 'raw' ? 5000 : 500,
        offset: 0,
      })
      const reportMetrics = summarizeEvents(result.events)
      const deptPart = departmentId === 'ALL' ? 'all' : departmentId.toLowerCase()

      if (downloadContent === 'raw') {
        const csv = toCsv(result.events)
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `access-events-${deptPart}-${from}-to-${to}.csv`
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
        setMessage(`已下載原始資料 CSV，共 ${result.events.length} 筆。`)
        return
      }

      const reportWindow = window.open('', '_blank')
      if (!reportWindow) {
        throw new Error('瀏覽器封鎖了圖形化報表視窗，請允許彈出視窗後再試一次。')
      }
      reportWindow.document.open()
      reportWindow.document.write(buildVisualReport(result.events, reportMetrics, from, to, departmentId))
      reportWindow.document.close()
      setMessage(`已開啟圖形化報表，共納入 ${result.events.length} 筆事件預覽。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '下載失敗')
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <AppShell title="報表中心" subtitle="出勤指標、事件分布與報表下載">
      <section className="panel-card mb-3">
        <div className="reports-toolbar">
          <div>
            <h2 className="h6 mb-1">報表條件</h2>
            <div className="small text-secondary">期間與下載設定</div>
          </div>
          <button className="btn btn-primary px-4" type="button" onClick={downloadReport} disabled={isDownloading || isLoading}>
            {isDownloading ? '下載中...' : '下載報表'}
          </button>
        </div>

        <div className="row g-3 align-items-end mt-1">
          <div className="col-md-3">
            <label className="form-label">起始日期</label>
            <input className="form-control" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="col-md-3">
            <label className="form-label">結束日期</label>
            <input className="form-control" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="col-md-3">
            <label className="form-label">部門</label>
            <select className="form-select" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
              <option value="ALL">全部可見部門</option>
              {departmentOptions.map((option) => (
                <option key={option.departmentId} value={option.departmentId}>
                  {'\u00A0'.repeat(option.depth * 2)}
                  {option.name} ({option.departmentId})
                </option>
              ))}
            </select>
          </div>
          <div className="col-md-3">
            <label className="form-label">下載內容</label>
            <select className="form-select" value={downloadContent} onChange={(event) => setDownloadContent(event.target.value as DownloadContent)}>
              <option value="visual">圖形化指標報表</option>
              <option value="raw">原始事件資料 CSV</option>
            </select>
          </div>
          {message && <div className="col-12 small text-secondary text-end">{message}</div>}
        </div>
      </section>

      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">預覽事件數</div>
          <div className="kpi-value">{isLoading ? '-' : metrics.total.toLocaleString()}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">允許 / 拒絕</div>
          <div className="kpi-value">
            {isLoading ? '-' : `${metrics.granted.toLocaleString()} / ${metrics.denied.toLocaleString()}`}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">拒絕率</div>
          <div className="kpi-value">{isLoading ? '-' : `${(metrics.deniedRate * 100).toFixed(1)}%`}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">全公司事件總量</div>
          <div className="kpi-value">{companyTotalEvents.toLocaleString()}</div>
        </div>
      </section>

      <section className="panel-grid mb-3">
        <div className="panel-card">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h2 className="h6 m-0">部門事件分布</h2>
            <span className="small text-secondary">Top {metrics.topDepartments.length}</span>
          </div>
          <div className="report-chart-list">
            {metrics.topDepartments.length > 0 ? (
              metrics.topDepartments.map((item) => (
                <div className="report-bar-row" key={item.departmentId}>
                  <span>{item.departmentId}</span>
                  <div className="report-bar-track">
                    <div className="report-bar-fill" style={{ width: `${Math.max(4, (item.count / maxDepartmentCount) * 100)}%` }} />
                  </div>
                  <strong>{item.count.toLocaleString()}</strong>
                </div>
              ))
            ) : (
              <div className="text-secondary small">目前沒有符合條件的部門事件。</div>
            )}
          </div>
        </div>

        <div className="panel-card">
          <h2 className="h6 mb-3">刷卡方向</h2>
          <div className="report-direction">
            <div>
              <span>IN</span>
              <strong>{metrics.inCount.toLocaleString()}</strong>
            </div>
            <div>
              <span>OUT</span>
              <strong>{metrics.outCount.toLocaleString()}</strong>
            </div>
          </div>
          <div className="report-mini-metric">
            平均延遲：{metrics.avgLatencyMs === null ? '-' : `${metrics.avgLatencyMs.toLocaleString()} ms`}
          </div>
        </div>
      </section>

      <section className="panel-card mb-3">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h2 className="h6 m-0">時段活動量</h2>
          <span className="small text-secondary">台北時間</span>
        </div>
        <div className="report-hour-grid">
          {metrics.hourlyActivity.length > 0 ? (
            metrics.hourlyActivity.map((item) => (
              <div className="report-hour" key={item.hour}>
                <div className="report-hour-bar" style={{ height: `${Math.max(8, (item.count / maxHourlyCount) * 100)}%` }} />
                <span>{item.hour}</span>
              </div>
            ))
          ) : (
            <div className="text-secondary small">目前沒有符合條件的刷卡時段。</div>
          )}
        </div>
      </section>

      <section className="panel-card">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h2 className="h6 m-0">事件明細預覽</h2>
          <span className="small text-secondary">最多顯示 500 筆</span>
        </div>
        <div className="table-responsive">
          <table className="table-clean">
            <thead>
              <tr>
                <th>時間</th>
                <th>員工</th>
                <th>部門</th>
                <th>門禁</th>
                <th>方向</th>
                <th>結果</th>
              </tr>
            </thead>
            <tbody>
              {events.length > 0 ? (
                events.slice(0, 20).map((event) => (
                  <tr key={event.requestId}>
                    <td>{new Date(event.timestamp).toLocaleString('zh-TW', { hour12: false })}</td>
                    <td>
                      {event.displayName || event.employeeId}
                      <div className="small text-secondary">{event.employeeId}</div>
                    </td>
                    <td>{event.departmentId}</td>
                    <td>{event.gateId}</td>
                    <td>{event.direction}</td>
                    <td className={event.decision === 'DENIED' ? 'danger-text' : undefined}>{event.decision}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="text-secondary text-center py-4">
                    {isLoading ? '載入中...' : '目前沒有符合條件的資料'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  )
}

export default Reports
