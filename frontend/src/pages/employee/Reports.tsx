import { useEffect, useMemo, useState } from 'react'
import AppShell from '../../components/layout/AppShell'
import { fetchCurrentUser, type CurrentUser } from '../../services/auth'
import {
  type AccessEvent,
  type DepartmentNode,
  type HourlyActivityItem,
  type WorkHourSummary,
  type WorkHourTrendPoint,
  fetchAccessEvents,
  fetchDepartmentTree,
  fetchReportCenterData,
  type ReportCenterResponse,
} from '../../services/accessEvents'

type DownloadContent = 'raw' | 'visual'
type TrendMode = 'monthly' | 'quarterly' | 'yearly'

type ReportMetrics = {
  total: number
  granted: number
  denied: number
  inCount: number
  outCount: number
  avgLatencyMs: number | null
  deniedRate: number
  topDepartments: Array<{ departmentId: string; count: number }>
  hourlyActivity: HourlyActivityItem[]
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
  const hourlyCounts = new Map<string, HourlyActivityItem>()
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
    const hourlyBucket = hourlyCounts.get(hour) ?? { hour, count: 0, inCount: 0, outCount: 0 }
    hourlyBucket.count += 1
    if (event.direction === 'IN') hourlyBucket.inCount += 1
    if (event.direction === 'OUT') hourlyBucket.outCount += 1
    hourlyCounts.set(hour, hourlyBucket)
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
    hourlyActivity: [...hourlyCounts.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
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

async function fetchAccessEventsForCsv(from: string, to: string, departmentId: string) {
  const pageSize = 200
  const maxRows = 5000
  const pages: AccessEvent[] = []

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const result = await fetchAccessEvents({
      from,
      to,
      departmentId,
      limit: pageSize,
      offset,
    })
    pages.push(...result.events)

    if (result.events.length < pageSize) {
      break
    }
  }

  return pages.slice(0, maxRows)
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

function niceTickStep(rawStep: number) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1

  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const fraction = rawStep / magnitude
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return niceFraction * magnitude
}

function buildCountAxis(maxValue: number, tickCount = 4) {
  const step = niceTickStep(maxValue / tickCount)
  const max = Math.max(step, Math.ceil(maxValue / step) * step)
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, index) => index * step)
  return { max, ticks }
}

function formatCount(value: number) {
  return Math.round(value).toLocaleString()
}

function stackedHourRows(items: HourlyActivityItem[]) {
  if (items.length === 0) {
    return '<div class="empty">沒有時段活動資料</div>'
  }

  const axis = buildCountAxis(Math.max(1, ...items.map((item) => item.count)))
  const axisLabels = axis.ticks
    .map((tick) => `<span style="left:${(tick / axis.max) * 100}%">${htmlEscape(formatCount(tick))}</span>`)
    .join('')
  const rows = items
    .map((item) => {
      const inWidth = (item.inCount / axis.max) * 100
      const outWidth = (item.outCount / axis.max) * 100
      return `
        <div class="hour-row">
          <span class="hour-label">${htmlEscape(`${item.hour}:00`)}</span>
          <div class="hour-track">
            <div class="hour-segment hour-in" style="width:${inWidth}%"></div>
            <div class="hour-segment hour-out" style="width:${outWidth}%"></div>
          </div>
          <strong>${htmlEscape(formatCount(item.count))}</strong>
        </div>
      `
    })
    .join('')

  return `
    <div class="hour-legend"><span><i class="hour-in"></i>IN</span><span><i class="hour-out"></i>OUT</span></div>
    <div class="hour-axis">${axisLabels}</div>
    <div class="hour-rows">${rows}</div>
  `
}

function lineTrendChart(items: WorkHourTrendPoint[]) {
  if (items.length === 0) {
    return '<div class="trend-empty">沒有工時趨勢資料</div>'
  }

  const width = 640
  const height = 174
  const padding = { top: 28, right: 32, bottom: 44, left: 40 }
  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom
  const maxHours = Math.max(1, ...items.map((item) => item.averageHours))
  const points = items.map((item, index) => {
    const x = padding.left + (items.length <= 1 ? innerWidth / 2 : (index / (items.length - 1)) * innerWidth)
    const y = padding.top + innerHeight - (item.averageHours / maxHours) * innerHeight
    return { ...item, x, y }
  })
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
  const gridLines = [0, 0.5, 1]
    .map((ratio) => {
      const y = padding.top + innerHeight - ratio * innerHeight
      return `<line class="trend-grid-line" x1="${padding.left}" x2="${width - padding.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" />`
    })
    .join('')
  const pointMarks = points
    .map(
      (point) => `
        <g>
          <circle class="trend-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" />
          <text class="trend-value" x="${point.x.toFixed(1)}" y="${Math.max(14, point.y - 10).toFixed(1)}">${htmlEscape(formatHours(point.averageHours))}</text>
          <text class="trend-label" x="${point.x.toFixed(1)}" y="${height - 16}">${htmlEscape(point.label)}</text>
        </g>
      `,
    )
    .join('')

  return `
    <svg class="trend-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="work hour trend">
      ${gridLines}
      ${points.length > 1 ? `<path class="trend-path" d="${path}" />` : ''}
      ${pointMarks}
    </svg>
  `
}

function formatDeniedRate(rate: number, denied: number) {
  const percentage = rate * 100
  if (denied > 0 && percentage > 0 && percentage < 0.1) {
    return '<0.1%'
  }
  return `${percentage.toFixed(1)}%`
}

function trendItems(workHours: WorkHourSummary | null, mode: TrendMode) {
  if (!workHours) return []
  if (mode === 'monthly') return workHours.monthlyTrend
  if (mode === 'quarterly') return workHours.quarterlyTrend
  return workHours.yearlyTrend
}

function trendTitle(mode: TrendMode) {
  if (mode === 'monthly') return '月工時趨勢'
  if (mode === 'quarterly') return '季工時趨勢'
  return '年工時趨勢'
}

function formatHours(value: number | null | undefined) {
  return typeof value === 'number' ? `${value.toFixed(1)}h` : '-'
}

function buildVisualReport(
  events: AccessEvent[],
  metrics: ReportMetrics,
  workHours: WorkHourSummary | null,
  from: string,
  to: string,
  departmentId: string,
  includeDepartmentDistribution: boolean,
  generationLatencyMs?: number,
) {
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
    <title>出勤報表</title>
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
      .hour-legend { display: flex; gap: 14px; justify-content: flex-end; margin-bottom: 8px; }
      .hour-legend span { align-items: center; color: #5f6b7a; display: inline-flex; font-size: 11px; gap: 5px; }
      .hour-legend i { display: inline-block; height: 8px; width: 18px; }
      .hour-row { align-items: center; display: grid; gap: 10px; grid-template-columns: 72px 1fr 58px; margin: 8px 0; }
      .hour-label, .hour-row strong { color: #172033; font-size: 12px; }
      .hour-track { background: #edf2f7; display: flex; height: 12px; overflow: hidden; }
      .hour-segment { height: 100%; }
      .hour-in { background: #1d4f73; }
      .hour-out { background: #17663a; }
      .hour-axis { border-bottom: 1px solid #d8dee6; height: 22px; margin-left: 82px; margin-right: 68px; position: relative; }
      .hour-axis span { color: #5f6b7a; font-size: 10px; position: absolute; top: 2px; transform: translateX(-50%); }
      .trend-line-chart { display: block; height: 174px; width: 100%; }
      .trend-grid-line { stroke: #d8dee6; stroke-width: 1; }
      .trend-path { fill: none; stroke: #1d4f73; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
      .trend-point { fill: #ffffff; stroke: #1d4f73; stroke-width: 2; }
      .trend-label { fill: #5f6b7a; font-size: 10px; text-anchor: middle; }
      .trend-value { fill: #0f2742; font-size: 11px; font-weight: 700; text-anchor: middle; }
      .trend-empty { color: #5f6b7a; font-size: 12px; padding: 18px; text-align: center; }
      table { border-collapse: collapse; font-size: 10px; width: 100%; }
      th, td { border: 1px solid #cfd6df; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #edf2f7; color: #253044; }
      .empty { color: #5f6b7a; padding: 18px; text-align: center; }
      @media print { body { margin: 14mm; } .metrics { grid-template-columns: repeat(2, 1fr); } }
    </style>
  </head>
  <body>
    <h1>出勤報表</h1>
    <div class="meta">期間：${htmlEscape(from)} 至 ${htmlEscape(to)} | 範圍：${htmlEscape(deptPart)} | 產生時間：${htmlEscape(generatedAt)}</div>
    <div class="metrics">
      ${metricLine('事件總數', metrics.total)}
      ${metricLine('允許通行', metrics.granted)}
      ${metricLine('拒絕通行', metrics.denied)}
      ${metricLine('拒絕率', formatDeniedRate(metrics.deniedRate, metrics.denied))}
      ${metricLine('刷進', metrics.inCount)}
      ${metricLine('刷出', metrics.outCount)}
      ${metricLine('平均延遲', metrics.avgLatencyMs === null ? '-' : `${metrics.avgLatencyMs} ms`)}
      ${metricLine('產製耗時', typeof generationLatencyMs === 'number' ? `${generationLatencyMs.toFixed(1)} ms` : '-')}
      ${metricLine('平均工時', formatHours(workHours?.averageHours))}
    </div>
    <h2>月工時趨勢</h2>
    <div class="chart">${lineTrendChart(workHours?.monthlyTrend ?? [])}</div>
    <h2>季工時趨勢</h2>
    <div class="chart">${lineTrendChart(workHours?.quarterlyTrend ?? [])}</div>
    <h2>年工時趨勢</h2>
    <div class="chart">${lineTrendChart(workHours?.yearlyTrend ?? [])}</div>
    ${
      includeDepartmentDistribution
        ? `<h2>部門事件分布</h2><div class="chart">${barRows(metrics.topDepartments.map((item) => ({ label: item.departmentId, value: item.count })))}</div>`
        : ''
    }
    <h2>時段活動量</h2>
    <div class="chart">${stackedHourRows(metrics.hourlyActivity)}</div>
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
  const [trendMode, setTrendMode] = useState<TrendMode>('monthly')
  const [events, setEvents] = useState<AccessEvent[]>([])
  const [reportData, setReportData] = useState<ReportCenterResponse | null>(null)
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOption[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isDownloading, setIsDownloading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setMessage(null)

    Promise.all([
      fetchReportCenterData({
        from,
        to,
        departmentId,
        limit: 500,
        offset: 0,
      }),
      fetchDepartmentTree(),
      fetchCurrentUser(),
    ])
      .then(([report, departments, user]) => {
        if (cancelled) return
        setReportData(report)
        setEvents(report.events)
        setCurrentUser(user)
        setDepartmentOptions(flattenDepartments(departments))
      })
      .catch((error) => {
        if (cancelled) return
        setReportData(null)
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

  const metrics = useMemo<ReportMetrics>(() => {
    if (!reportData) {
      return summarizeEvents(events)
    }

    return {
      total: reportData.metrics.totalEvents,
      granted: reportData.metrics.grantedEvents,
      denied: reportData.metrics.deniedEvents,
      inCount: reportData.metrics.inEvents,
      outCount: reportData.metrics.outEvents,
      avgLatencyMs: reportData.metrics.avgLatencyMs === null ? null : Math.round(reportData.metrics.avgLatencyMs),
      deniedRate: reportData.metrics.deniedRate / 100,
      topDepartments: reportData.topDepartments,
      hourlyActivity: reportData.hourlyActivity,
    }
  }, [events, reportData])
  const maxDepartmentCount = Math.max(1, ...metrics.topDepartments.map((item) => item.count))
  const maxHourlyCount = Math.max(1, ...metrics.hourlyActivity.map((item) => item.count))
  const isEmployee = currentUser?.role === 'EMPLOYEE'
  const activeTrend = trendItems(reportData?.workHours ?? null, trendMode)
  const maxTrendHours = Math.max(1, ...activeTrend.map((item) => item.averageHours))
  const trendChartWidth = 640
  const trendChartHeight = 154
  const trendChartPadding = { top: 22, right: 28, bottom: 34, left: 28 }
  const trendInnerWidth = trendChartWidth - trendChartPadding.left - trendChartPadding.right
  const trendInnerHeight = 82
  const trendPoints = activeTrend.map((item, index) => {
    const x = trendChartPadding.left + (activeTrend.length <= 1 ? trendInnerWidth / 2 : (index / (activeTrend.length - 1)) * trendInnerWidth)
    const y = trendChartPadding.top + trendInnerHeight - (item.averageHours / maxTrendHours) * trendInnerHeight
    return { ...item, x, y }
  })
  const trendPath = trendPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
  const hourlyAxis = buildCountAxis(maxHourlyCount)

  const downloadReport = async () => {
    setIsDownloading(true)
    setMessage(null)

    try {
      const deptPart = departmentId === 'ALL' ? 'all' : departmentId.toLowerCase()

      if (downloadContent === 'raw') {
        const eventsForCsv = await fetchAccessEventsForCsv(from, to, departmentId)
        const csv = toCsv(eventsForCsv)
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `access-events-${deptPart}-${from}-to-${to}.csv`
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
        setMessage(`已下載原始資料 CSV，共 ${eventsForCsv.length} 筆。`)
        return
      }

      const result = await fetchReportCenterData({
        from,
        to,
        departmentId,
        limit: 500,
        offset: 0,
      })
      const reportMetrics: ReportMetrics = {
        total: result.metrics.totalEvents,
        granted: result.metrics.grantedEvents,
        denied: result.metrics.deniedEvents,
        inCount: result.metrics.inEvents,
        outCount: result.metrics.outEvents,
        avgLatencyMs: result.metrics.avgLatencyMs === null ? null : Math.round(result.metrics.avgLatencyMs),
        deniedRate: result.metrics.deniedRate / 100,
        topDepartments: result.topDepartments,
        hourlyActivity: result.hourlyActivity,
      }

      const reportHtml = buildVisualReport(result.events, reportMetrics, result.workHours, from, to, departmentId, !isEmployee, result.generationLatencyMs)
      const reportUrl = URL.createObjectURL(new Blob([reportHtml], { type: 'text/html;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = reportUrl
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(reportUrl), 60_000)
      setMessage(`已開啟報表，共納入 ${result.events.length} 筆事件預覽。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '下載失敗')
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <AppShell title={isEmployee ? '我的報表' : '報表中心'} subtitle="平均工時、工時趨勢與報表下載">
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
            <label className="form-label" htmlFor="report-from-date">起始日期</label>
            <input id="report-from-date" className="form-control" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="col-md-3">
            <label className="form-label" htmlFor="report-to-date">結束日期</label>
            <input id="report-to-date" className="form-control" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          {!isEmployee ? (
            <div className="col-md-3">
            <label className="form-label" htmlFor="report-department">部門</label>
            <select id="report-department" className="form-select" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
              <option value="ALL">全部可見部門</option>
              {departmentOptions.map((option) => (
                <option key={option.departmentId} value={option.departmentId}>
                  {'\u00A0'.repeat(option.depth * 2)}
                  {option.name} ({option.departmentId})
                </option>
              ))}
            </select>
            </div>
          ) : null}
          <div className="col-md-3">
            <label className="form-label" htmlFor="report-download-content">下載內容</label>
            <select id="report-download-content" className="form-select" value={downloadContent} onChange={(event) => setDownloadContent(event.target.value as DownloadContent)}>
              <option value="visual">{isEmployee ? '我的報表' : '出勤趨勢報表'}</option>
              <option value="raw">原始事件資料 CSV</option>
            </select>
          </div>
          {message && <div className="col-12 small text-secondary text-end">{message}</div>}
        </div>
      </section>

      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">平均工時</div>
          <div className="kpi-value">{isLoading ? '-' : formatHours(reportData?.workHours.averageHours)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">刷卡事件數</div>
          <div className="kpi-value">{isLoading ? '-' : metrics.total.toLocaleString()}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">資料產製耗時</div>
          <div className="kpi-value">{isLoading ? '-' : `${(reportData?.generationLatencyMs ?? 0).toFixed(1)}`}</div>
          <div className="kpi-footnote">ms</div>
        </div>
      </section>

      <section className="panel-card work-trend-panel mb-3">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h2 className="h6 m-0">{trendTitle(trendMode)}</h2>
          <select className="form-select form-select-sm w-auto" value={trendMode} onChange={(event) => setTrendMode(event.target.value as TrendMode)}>
            <option value="monthly">月</option>
            <option value="quarterly">季</option>
            <option value="yearly">年</option>
          </select>
        </div>
        <div className="work-trend-chart">
          {activeTrend.length > 0 ? (
            <svg className="work-trend-line" viewBox={`0 0 ${trendChartWidth} ${trendChartHeight}`} role="img" aria-label={trendTitle(trendMode)}>
              {[0, 0.5, 1].map((ratio) => {
                const y = trendChartPadding.top + trendInnerHeight - ratio * trendInnerHeight
                return <line className="work-trend-grid-line" key={ratio} x1={trendChartPadding.left} x2={trendChartWidth - trendChartPadding.right} y1={y} y2={y} />
              })}
              {trendPoints.length > 1 ? <path className="work-trend-path" d={trendPath} /> : null}
              {trendPoints.map((point: WorkHourTrendPoint & { x: number; y: number }) => (
                <g key={point.label}>
                  <circle className="work-trend-point" cx={point.x} cy={point.y} r="4" />
                  <text className="work-trend-value" x={point.x} y={Math.max(14, point.y - 10)}>
                    {formatHours(point.averageHours)}
                  </text>
                  <text className="work-trend-label" x={point.x} y={trendChartHeight - 16}>
                    {point.label}
                  </text>
                </g>
              ))}
            </svg>
          ) : (
            <div className="work-trend-empty text-secondary small">目前沒有完整進出可計算工時。</div>
          )}
        </div>
      </section>

      <section className="panel-grid mb-3">
        {!isEmployee ? (
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
              <div className="text-secondary small">目前沒有可比較的下轄部門事件。</div>
            )}
          </div>
          </div>
        ) : null}

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
        <div className="report-hourly-chart">
          {metrics.hourlyActivity.length > 0 ? (
            <>
              <div className="report-hourly-legend" aria-label="IN OUT 圖例">
                <span><i className="report-hourly-in" />IN</span>
                <span><i className="report-hourly-out" />OUT</span>
              </div>
              <div className="report-hourly-axis" aria-hidden="true">
                {hourlyAxis.ticks.map((tick) => (
                  <span key={tick} style={{ left: `${(tick / hourlyAxis.max) * 100}%` }}>
                    {formatCount(tick)}
                  </span>
                ))}
              </div>
              <div className="report-hourly-list">
                {metrics.hourlyActivity.map((item) => (
                  <div className="report-hourly-row" key={item.hour} title={`${item.hour}:00 IN ${item.inCount.toLocaleString()} / OUT ${item.outCount.toLocaleString()} / total ${item.count.toLocaleString()}`}>
                    <span className="report-hourly-label">{item.hour}:00</span>
                    <div className="report-hourly-track">
                      <div className="report-hourly-segment report-hourly-in" style={{ width: `${(item.inCount / hourlyAxis.max) * 100}%` }} />
                      <div className="report-hourly-segment report-hourly-out" style={{ width: `${(item.outCount / hourlyAxis.max) * 100}%` }} />
                    </div>
                    <strong>{item.count.toLocaleString()}</strong>
                  </div>
                ))}
              </div>
            </>
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
