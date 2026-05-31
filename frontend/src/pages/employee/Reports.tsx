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
  fetchEmployeeOptions,
  type EmployeeOptionItem,
  type ReportCenterResponse,
} from '../../services/accessEvents'

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

type ReportSectionOptions = {
  coreKpi: boolean
  attendanceRate: boolean
  periodAttendanceCount: boolean
  departmentStaySummary: boolean
  departmentStayRanking: boolean
  departmentAttendanceRate: boolean
  anomalySummary: boolean
  averageWorkHours: boolean
  trendAnalysis: boolean
  attendanceTrend: boolean
  eventMetrics: boolean
  eventMetricOptions: EventMetricOptions
  workTrend: boolean
  organizationAnalysis: boolean
  departmentDistribution: boolean
  hourlyActivity: boolean
  eventDetails: boolean
  attendanceDetails: boolean
}

type EventMetricOptions = {
  total: boolean
  granted: boolean
  denied: boolean
  deniedRate: boolean
  inCount: boolean
  outCount: boolean
  avgLatency: boolean
}

type AttendanceDetailOptions = {
  firstIn: boolean
  lastOut: boolean
  workHours: boolean
  inGate: boolean
  outGate: boolean
  anomalies: boolean
}

type AttendanceDetailRow = {
  key: string
  date: string
  employeeId: string
  displayName: string
  departmentId: string
  firstIn?: AccessEvent
  lastOut?: AccessEvent
  workHours: number | null
  anomalies: AccessEvent[]
}

type ReportTargetMode = 'department' | 'employee'

type EmployeeOption = {
  employeeId: string
  displayName: string
  departmentId: string
}

type DepartmentStayStat = {
  departmentId: string
  totalHours: number
  averageHours: number | null
  workDays: number
  employeeCount: number
  normalAttendanceRate: number | null
}

type HrMetrics = {
  attendanceRate: number | null
  normalAttendanceRate: number | null
  periodAttendanceCount: number
  anomalyDays: number
  averageStayHours: number | null
  departmentStayStats: DepartmentStayStat[]
}

type DailyAttendanceTrendPoint = {
  label: string
  count: number
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

function localDateKey(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : localDateInputValue(date)
}

function localTimeText(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

// The live preview defaults to a small window so the cold load stays cheap, but
const LIVE_VIEW_DEFAULT_DAYS = 7

function monthsAgoDate(months: number) {
  const date = new Date()
  date.setMonth(date.getMonth() - months)
  return localDateInputValue(date)
}

function daysAgoDate(days: number) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return localDateInputValue(date)
}

function addMonths(dateStr: string, months: number) {
  const date = new Date(dateStr)
  date.setMonth(date.getMonth() + months)
  return localDateInputValue(date)
}

// Default preview window on first load — small, so the cold fetch is light.
function defaultFromDate() {
  return daysAgoDate(LIVE_VIEW_DEFAULT_DAYS)
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

function buildAttendanceDetails(events: AccessEvent[]): AttendanceDetailRow[] {
  const groups = new Map<string, AttendanceDetailRow & { grantedIn: AccessEvent[]; grantedOut: AccessEvent[] }>()

  for (const event of events) {
    const date = localDateKey(event.timestamp)
    const key = `${date}-${event.employeeId}`
    const row =
      groups.get(key) ??
      {
        key,
        date,
        employeeId: event.employeeId,
        displayName: event.displayName?.trim() || event.employeeId,
        departmentId: event.departmentId || '-',
        workHours: null,
        anomalies: [],
        grantedIn: [],
        grantedOut: [],
      }

    if (!row.displayName || row.displayName === row.employeeId) row.displayName = event.displayName?.trim() || event.employeeId
    if (event.departmentId) row.departmentId = event.departmentId
    if (event.decision === 'GRANTED' && event.direction === 'IN') row.grantedIn.push(event)
    if (event.decision === 'GRANTED' && event.direction === 'OUT') row.grantedOut.push(event)
    if (event.decision === 'DENIED') row.anomalies.push(event)
    groups.set(key, row)
  }

  return [...groups.values()]
    .map((row) => {
      const grantedIn = [...row.grantedIn].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      const grantedOut = [...row.grantedOut].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      const firstIn = grantedIn[0]
      const lastOut = grantedOut.at(-1)
      const firstInTime = firstIn ? new Date(firstIn.timestamp).getTime() : NaN
      const lastOutTime = lastOut ? new Date(lastOut.timestamp).getTime() : NaN
      const workHours = Number.isFinite(firstInTime) && Number.isFinite(lastOutTime) && lastOutTime > firstInTime ? (lastOutTime - firstInTime) / 3_600_000 : null
      // Strip the raw grouping arrays; only the derived fields below are returned.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { grantedIn: _grantedIn, grantedOut: _grantedOut, ...cleanRow } = row
      return { ...cleanRow, firstIn, lastOut, workHours }
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.employeeId.localeCompare(b.employeeId))
}

function buildEmployeeOptions(events: AccessEvent[]): EmployeeOption[] {
  const options = new Map<string, EmployeeOption>()

  for (const event of events) {
    if (!event.employeeId) continue
    const existing = options.get(event.employeeId)
    options.set(event.employeeId, {
      employeeId: event.employeeId,
      displayName: event.displayName?.trim() || existing?.displayName || event.employeeId,
      departmentId: event.departmentId || existing?.departmentId || '-',
    })
  }

  return [...options.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId))
}

function employeeSearchLabel(employee: EmployeeOption) {
  return `${employee.employeeId} | ${employee.displayName} | ${employee.departmentId}`
}

function toEmployeeOption(employee: EmployeeOptionItem): EmployeeOption {
  return {
    employeeId: employee.employeeId,
    displayName: employee.displayName?.trim() || employee.employeeId,
    departmentId: employee.departmentId || '-',
  }
}
function buildHrMetrics(attendanceDetails: AttendanceDetailRow[]): HrMetrics {
  const totalRows = attendanceDetails.length
  const attendedRows = attendanceDetails.filter((row) => row.firstIn).length
  const normalRows = attendanceDetails.filter((row) => row.firstIn && row.lastOut && row.anomalies.length === 0).length
  const anomalyDays = attendanceDetails.filter((row) => row.anomalies.length > 0 || !row.firstIn || !row.lastOut).length
  const periodAttendanceCount = new Set(attendanceDetails.filter((row) => row.firstIn).map((row) => row.employeeId)).size
  const stayRows = attendanceDetails.filter((row) => typeof row.workHours === 'number')
  const totalStayHours = stayRows.reduce((sum, row) => sum + (row.workHours ?? 0), 0)
  const departments = new Map<string, { totalHours: number; workDays: number; employees: Set<string>; totalRows: number; normalRows: number }>()

  for (const row of attendanceDetails) {
    const departmentId = row.departmentId || '-'
    const stat = departments.get(departmentId) ?? { totalHours: 0, workDays: 0, employees: new Set<string>(), totalRows: 0, normalRows: 0 }
    stat.totalRows += 1
    if (row.firstIn && row.lastOut && row.anomalies.length === 0) stat.normalRows += 1
    departments.set(departmentId, stat)
  }

  for (const row of stayRows) {
    const departmentId = row.departmentId || '-'
    const stat = departments.get(departmentId) ?? { totalHours: 0, workDays: 0, employees: new Set<string>(), totalRows: 0, normalRows: 0 }
    stat.totalHours += row.workHours ?? 0
    stat.workDays += 1
    stat.employees.add(row.employeeId)
    departments.set(departmentId, stat)
  }

  return {
    attendanceRate: totalRows > 0 ? (attendedRows / totalRows) * 100 : null,
    normalAttendanceRate: totalRows > 0 ? (normalRows / totalRows) * 100 : null,
    periodAttendanceCount,
    anomalyDays,
    averageStayHours: stayRows.length > 0 ? totalStayHours / stayRows.length : null,
    departmentStayStats: [...departments.entries()]
      .map(([departmentId, stat]) => ({
        departmentId,
        totalHours: stat.totalHours,
        averageHours: stat.workDays > 0 ? stat.totalHours / stat.workDays : null,
        workDays: stat.workDays,
        employeeCount: stat.employees.size,
        normalAttendanceRate: stat.totalRows > 0 ? (stat.normalRows / stat.totalRows) * 100 : null,
      }))
      .sort((a, b) => b.totalHours - a.totalHours),
  }
}

function buildDailyAttendanceTrend(attendanceDetails: AttendanceDetailRow[]): DailyAttendanceTrendPoint[] {
  const byDate = new Map<string, Set<string>>()

  for (const row of attendanceDetails) {
    if (!row.firstIn) continue
    const employees = byDate.get(row.date) ?? new Set<string>()
    employees.add(row.employeeId)
    byDate.set(row.date, employees)
  }

  return [...byDate.entries()]
    .map(([label, employees]) => ({ label, count: employees.size }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function metricLine(label: string, value: string | number) {
  return `<div class="metric"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong></div>`
}

function eventDetailRows(events: AccessEvent[]) {
  return events.length > 0
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
    : '<tr><td colspan="8" class="empty">這段期間沒有事件資料</td></tr>'
}

function attendanceDetailHeaders(options: AttendanceDetailOptions) {
  return [
    '<th>日期</th>',
    '<th>員工編號</th>',
    '<th>姓名</th>',
    '<th>部門</th>',
    options.firstIn ? '<th>上班</th>' : '',
    options.inGate ? '<th>刷入門禁</th>' : '',
    options.lastOut ? '<th>下班</th>' : '',
    options.outGate ? '<th>刷出門禁</th>' : '',
    options.workHours ? '<th>工時</th>' : '',
    options.anomalies ? '<th>異常事件</th>' : '',
  ].join('')
}

function attendanceDetailRows(rows: AttendanceDetailRow[], options: AttendanceDetailOptions) {
  if (rows.length === 0) {
    const colSpan = 4 + Object.values(options).filter(Boolean).length
    return `<tr><td colspan="${colSpan}" class="empty">這段期間沒有出勤明細</td></tr>`
  }

  return rows
    .slice(0, 80)
    .map((row) => {
      const anomalyText =
        row.anomalies.length > 0
          ? row.anomalies
              .slice(0, 3)
              .map((event) => `${localTimeText(event.timestamp)} ${event.reason || event.decision}`)
              .join('；')
          : '-'

      return `
        <tr>
          <td>${htmlEscape(row.date)}</td>
          <td>${htmlEscape(row.employeeId)}</td>
          <td>${htmlEscape(row.displayName || '-')}</td>
          <td>${htmlEscape(row.departmentId)}</td>
          ${options.firstIn ? `<td>${htmlEscape(localTimeText(row.firstIn?.timestamp))}</td>` : ''}
          ${options.inGate ? `<td>${htmlEscape(row.firstIn?.gateId ?? '-')}</td>` : ''}
          ${options.lastOut ? `<td>${htmlEscape(localTimeText(row.lastOut?.timestamp))}</td>` : ''}
          ${options.outGate ? `<td>${htmlEscape(row.lastOut?.gateId ?? '-')}</td>` : ''}
          ${options.workHours ? `<td>${htmlEscape(formatHours(row.workHours))}</td>` : ''}
          ${options.anomalies ? `<td>${htmlEscape(anomalyText)}</td>` : ''}
        </tr>
      `
    })
    .join('')
}

function departmentStayRows(items: DepartmentStayStat[]) {
  if (items.length === 0) {
    return '<tr><td colspan="6" class="empty">這段期間沒有部門停留時數資料</td></tr>'
  }

  return items
    .slice(0, 12)
    .map(
      (item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${htmlEscape(item.departmentId)}</td>
          <td>${htmlEscape(formatHours(item.totalHours))}</td>
          <td>${htmlEscape(formatHours(item.averageHours))}</td>
          <td>${htmlEscape(item.employeeCount)}</td>
          <td>${htmlEscape(formatPercentValue(item.normalAttendanceRate))}</td>
        </tr>
      `,
    )
    .join('')
}

function departmentAttendanceRows(items: DepartmentStayStat[]) {
  if (items.length === 0) {
    return '<tr><td colspan="4" class="empty">這段期間沒有部門出勤率資料</td></tr>'
  }

  return [...items]
    .sort((a, b) => (b.normalAttendanceRate ?? -1) - (a.normalAttendanceRate ?? -1))
    .slice(0, 12)
    .map(
      (item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${htmlEscape(item.departmentId)}</td>
          <td>${htmlEscape(formatPercentValue(item.normalAttendanceRate))}</td>
          <td>${htmlEscape(item.workDays)}</td>
        </tr>
      `,
    )
    .join('')
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

function attendanceTrendChart(items: DailyAttendanceTrendPoint[]) {
  if (items.length === 0) {
    return '<div class="trend-empty">沒有出勤人數趨勢資料</div>'
  }

  const width = 640
  const height = 174
  const padding = { top: 28, right: 32, bottom: 44, left: 40 }
  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom
  const maxCount = Math.max(1, ...items.map((item) => item.count))
  const points = items.map((item, index) => {
    const x = padding.left + (items.length <= 1 ? innerWidth / 2 : (index / (items.length - 1)) * innerWidth)
    const y = padding.top + innerHeight - (item.count / maxCount) * innerHeight
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
          <text class="trend-value" x="${point.x.toFixed(1)}" y="${Math.max(14, point.y - 10).toFixed(1)}">${htmlEscape(point.count)}</text>
          <text class="trend-label" x="${point.x.toFixed(1)}" y="${height - 16}">${htmlEscape(point.label.slice(5))}</text>
        </g>
      `,
    )
    .join('')

  return `
    <svg class="trend-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="attendance trend">
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

function formatPercentValue(value: number | null | undefined) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '-'
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
  attendanceDetails: AttendanceDetailRow[],
  hrMetrics: HrMetrics,
  from: string,
  to: string,
  departmentId: string,
  targetLabel: string,
  preparerName: string,
  sectionOptions: ReportSectionOptions,
  attendanceOptions: AttendanceDetailOptions,
  generationLatencyMs?: number,
  attendanceTrend?: DailyAttendanceTrendPoint[] | null,
) {
  const generatedAt = new Date().toLocaleString('zh-TW', { hour12: false })
  const deptPart = departmentId === 'ALL' ? '全部部門' : departmentId
  const targetPart = targetLabel && targetLabel !== deptPart ? ` | 報表對象：${htmlEscape(targetLabel)}` : ''
  const generationLatencyText = typeof generationLatencyMs === 'number' ? `${generationLatencyMs.toFixed(1)}ms` : '-'
  // Use the server's window-wide trend when provided; otherwise derive locally.
  const dailyAttendanceTrend = attendanceTrend ?? buildDailyAttendanceTrend(attendanceDetails)

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
      table { border-collapse: collapse; font-size: 10px; margin-bottom: 18px; width: 100%; }
      th, td { border: 1px solid #cfd6df; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #edf2f7; color: #253044; }
      .empty { color: #5f6b7a; padding: 18px; text-align: center; }
      @media print { body { margin: 14mm; } .metrics { grid-template-columns: repeat(2, 1fr); } }
    </style>
  </head>
  <body>
    <h1>出勤報表</h1>
    <div class="meta">期間：${htmlEscape(from)} 至 ${htmlEscape(to)} | 範圍：${htmlEscape(deptPart)}${targetPart} | 製表人：${htmlEscape(preparerName)} | 產生時間：${htmlEscape(generatedAt)} | 此次報表產製耗時：${htmlEscape(generationLatencyText)}</div>
    ${
      sectionOptions.coreKpi && (sectionOptions.attendanceRate || sectionOptions.periodAttendanceCount || sectionOptions.averageWorkHours || sectionOptions.anomalySummary)
        ? `<h2>核心出勤 KPI</h2><div class="metrics">
            ${sectionOptions.attendanceRate ? metricLine('期間正常出勤率', formatPercentValue(hrMetrics.normalAttendanceRate)) : ''}
            ${sectionOptions.periodAttendanceCount ? metricLine('期間出勤人數', hrMetrics.periodAttendanceCount) : ''}
            ${sectionOptions.averageWorkHours ? metricLine('期間平均工時', formatHours(hrMetrics.averageStayHours)) : ''}
            ${sectionOptions.anomalySummary ? metricLine('異常天數', hrMetrics.anomalyDays) : ''}
          </div>`
        : ''
    }
    ${
      sectionOptions.organizationAnalysis && sectionOptions.departmentStaySummary
        ? `<h2>組織停留時數統計</h2><div class="metrics">${metricLine('期間平均停留時數', formatHours(hrMetrics.averageStayHours))}</div>`
        : ''
    }
    ${
      sectionOptions.organizationAnalysis && sectionOptions.departmentStayRanking
        ? `<h2>部門停留時數排名</h2>
          <table>
            <thead><tr><th>排名</th><th>部門</th><th>總停留時數</th><th>平均停留時數</th><th>人數</th><th>正常出勤率</th></tr></thead>
            <tbody>${departmentStayRows(hrMetrics.departmentStayStats)}</tbody>
          </table>`
        : ''
    }
    ${
      sectionOptions.organizationAnalysis && sectionOptions.departmentAttendanceRate
        ? `<h2>部門正常出勤率</h2>
          <table>
            <thead><tr><th>排名</th><th>部門</th><th>正常出勤率</th><th>有效出勤日數</th></tr></thead>
            <tbody>${departmentAttendanceRows(hrMetrics.departmentStayStats)}</tbody>
          </table>`
        : ''
    }
    ${
      sectionOptions.eventMetrics
        ? `<h2>刷卡事件統計</h2><div class="metrics">
            ${sectionOptions.eventMetricOptions.total ? metricLine('期間刷卡事件總數', metrics.total) : ''}
            ${sectionOptions.eventMetricOptions.granted ? metricLine('允許通行數', metrics.granted) : ''}
            ${sectionOptions.eventMetricOptions.denied ? metricLine('拒絕通行數', metrics.denied) : ''}
            ${sectionOptions.eventMetricOptions.deniedRate ? metricLine('拒絕率', formatDeniedRate(metrics.deniedRate, metrics.denied)) : ''}
            ${sectionOptions.eventMetricOptions.inCount ? metricLine('刷進次數', metrics.inCount) : ''}
            ${sectionOptions.eventMetricOptions.outCount ? metricLine('刷出次數', metrics.outCount) : ''}
            ${sectionOptions.eventMetricOptions.avgLatency ? metricLine('刷卡平均延遲', metrics.avgLatencyMs === null ? '-' : `${metrics.avgLatencyMs} ms`) : ''}
          </div>`
        : ''
    }
    ${
      sectionOptions.trendAnalysis && sectionOptions.attendanceTrend
        ? `<h2>期間出勤人數趨勢</h2><div class="chart">${attendanceTrendChart(dailyAttendanceTrend)}</div>`
        : ''
    }
    ${
      sectionOptions.trendAnalysis && sectionOptions.workTrend
        ? `<h2>月工時趨勢</h2>
          <div class="chart">${lineTrendChart(workHours?.monthlyTrend ?? [])}</div>
          <h2>季工時趨勢</h2>
          <div class="chart">${lineTrendChart(workHours?.quarterlyTrend ?? [])}</div>
          <h2>年工時趨勢</h2>
          <div class="chart">${lineTrendChart(workHours?.yearlyTrend ?? [])}</div>`
        : ''
    }
    ${
      sectionOptions.organizationAnalysis && sectionOptions.departmentDistribution
        ? `<h2>部門刷卡事件分布</h2><div class="chart">${barRows(metrics.topDepartments.map((item) => ({ label: item.departmentId, value: item.count })))}</div>`
        : ''
    }
    ${sectionOptions.trendAnalysis && sectionOptions.hourlyActivity ? `<h2>時段活動量趨勢</h2><div class="chart">${stackedHourRows(metrics.hourlyActivity)}</div>` : ''}
    ${
      sectionOptions.eventDetails
        ? `<h2>事件明細</h2>
          <table>
            <thead><tr><th>時間</th><th>員工編號</th><th>姓名</th><th>部門</th><th>門禁</th><th>方向</th><th>結果</th><th>原因</th></tr></thead>
            <tbody>${eventDetailRows(events)}</tbody>
          </table>`
        : ''
    }
    ${
      sectionOptions.attendanceDetails
        ? `<h2>出勤日明細</h2>
          <table>
            <thead><tr>${attendanceDetailHeaders(attendanceOptions)}</tr></thead>
            <tbody>${attendanceDetailRows(attendanceDetails, attendanceOptions)}</tbody>
          </table>`
        : ''
    }
    <script>
      window.addEventListener('load', () => {
        setTimeout(() => window.print(), 250)
      })
    </script>
  </body>
</html>`
}

type RangePreset = 'today' | 'last3d' | 'last7d' | 'thisMonth' | 'last3m' | 'custom'

const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'today',     label: '今天' },
  { key: 'last3d',    label: '近3天' },
  { key: 'last7d',    label: '近7天' },
  { key: 'thisMonth', label: '本月' },
  { key: 'last3m',    label: '3個月內' },
  { key: 'custom',    label: '自定義' },
]

function startOfMonthDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function resolvePresetRange(preset: RangePreset, customFrom: string, customTo: string) {
  const today = localDateInputValue(new Date())
  switch (preset) {
    case 'today':     return { from: today, to: today }
    case 'last3d':    return { from: daysAgoDate(3), to: today }
    case 'last7d':    return { from: daysAgoDate(7), to: today }
    case 'thisMonth': return { from: startOfMonthDate(), to: today }
    case 'last3m':    return { from: monthsAgoDate(3), to: today }
    case 'custom':    return { from: customFrom, to: customTo }
  }
}

function Reports() {
  const [rangePreset, setRangePreset] = useState<RangePreset>('last7d')
  const [customFrom, setCustomFrom] = useState(defaultFromDate)
  const [customTo, setCustomTo] = useState(() => localDateInputValue(new Date()))
  const [targetMode, setTargetMode] = useState<ReportTargetMode>('department')
  const [departmentId, setDepartmentId] = useState('ALL')
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')
  const [trendMode, setTrendMode] = useState<TrendMode>('monthly')
  const [events, setEvents] = useState<AccessEvent[]>([])
  const [reportData, setReportData] = useState<ReportCenterResponse | null>(null)
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOption[]>([])
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isDownloading, setIsDownloading] = useState(false)
  const [showReportOptionDetails, setShowReportOptionDetails] = useState(false)
  const [showCoreKpi, setShowCoreKpi] = useState(true)
  const [showAttendanceRate, setShowAttendanceRate] = useState(true)
  const [showPeriodAttendanceCount, setShowPeriodAttendanceCount] = useState(true)
  const [showDepartmentStaySummary, setShowDepartmentStaySummary] = useState(true)
  const [showDepartmentStayRanking, setShowDepartmentStayRanking] = useState(true)
  const [showDepartmentAttendanceRate, setShowDepartmentAttendanceRate] = useState(true)
  const [showAnomalySummary, setShowAnomalySummary] = useState(true)
  const [showAverageWorkHours, setShowAverageWorkHours] = useState(true)
  const [showTrendAnalysis, setShowTrendAnalysis] = useState(true)
  const [showAttendanceTrend, setShowAttendanceTrend] = useState(true)
  const [showEventMetrics, setShowEventMetrics] = useState(false)
  const [eventMetricOptions, setEventMetricOptions] = useState<EventMetricOptions>({
    total: true,
    granted: true,
    denied: true,
    deniedRate: true,
    inCount: true,
    outCount: true,
    avgLatency: true,
  })
  const [showWorkTrend, setShowWorkTrend] = useState(true)
  const [showOrganizationAnalysis, setShowOrganizationAnalysis] = useState(true)
  const [showDepartmentDistribution, setShowDepartmentDistribution] = useState(true)
  const [showHourlyActivity, setShowHourlyActivity] = useState(true)
  const [showEventDetails, setShowEventDetails] = useState(false)
  const [showAttendanceDetails, setShowAttendanceDetails] = useState(true)
  const [attendanceDetailOptions, setAttendanceDetailOptions] = useState<AttendanceDetailOptions>({
    firstIn: true,
    lastOut: true,
    workHours: true,
    inGate: true,
    outGate: true,
    anomalies: true,
  })
  const [message, setMessage] = useState<string | null>(null)
  const [attendancePage, setAttendancePage] = useState(0)
  // Event details table — independent server-side pagination
  const EVENT_TABLE_PAGE_SIZE = 20
  const [eventTableOffset, setEventTableOffset] = useState(0)
  const [eventTableItems, setEventTableItems] = useState<AccessEvent[]>([])
  const [eventTableTotal, setEventTableTotal] = useState(0)
  const [eventTableLoading, setEventTableLoading] = useState(false)
  const activeEmployeeId = targetMode === 'employee' && selectedEmployeeId.trim() ? selectedEmployeeId.trim() : undefined
  const activeDepartmentId = targetMode === 'department' ? departmentId : 'ALL'
  const todayValue = localDateInputValue(new Date())
  const { from: liveFrom, to } = useMemo(
    () => resolvePresetRange(rangePreset, customFrom, customTo),
    [rangePreset, customFrom, customTo],
  )

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setMessage(null)
    setAttendancePage(0)
    setEventTableOffset(0)

    Promise.all([
      fetchReportCenterData({
        from: liveFrom,
        to,
        departmentId: activeDepartmentId,
        employeeId: activeEmployeeId,
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
  }, [activeDepartmentId, activeEmployeeId, liveFrom, to])

  // Independent server-side pagination for event details table
  useEffect(() => {
    let cancelled = false
    setEventTableLoading(true)
    fetchAccessEvents({
      departmentId: activeDepartmentId !== 'ALL' ? activeDepartmentId : undefined,
      employeeId: activeEmployeeId,
      from: liveFrom,
      to,
      limit: EVENT_TABLE_PAGE_SIZE,
      offset: eventTableOffset,
    })
      .then((result) => {
        if (cancelled) return
        setEventTableItems(result.events)
        setEventTableTotal(result.total)
      })
      .catch(() => { if (!cancelled) setEventTableItems([]) })
      .finally(() => { if (!cancelled) setEventTableLoading(false) })
    return () => { cancelled = true }
  }, [activeDepartmentId, activeEmployeeId, liveFrom, to, eventTableOffset])

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
  const attendanceDetails = useMemo(() => buildAttendanceDetails(events), [events])
  // Prefer the server-side aggregates (computed over the whole window) so the
  // headcount / stay-hours / trend aren't skewed by the capped event preview.
  // Fall back to deriving from events only when an older backend omits them.
  const dailyAttendanceTrend = useMemo(
    () => reportData?.attendanceTrend ?? buildDailyAttendanceTrend(attendanceDetails),
    [reportData, attendanceDetails],
  )
  const eventEmployeeOptions = useMemo(() => buildEmployeeOptions(events), [events])
  const visibleEmployeeOptions = useMemo(() => {
    const merged = new Map<string, EmployeeOption>()
    for (const employee of employeeOptions) merged.set(employee.employeeId, employee)
    for (const employee of eventEmployeeOptions) {
      if (!merged.has(employee.employeeId)) merged.set(employee.employeeId, employee)
    }
    return [...merged.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId))
  }, [employeeOptions, eventEmployeeOptions])
  const hrMetrics = useMemo(
    () => reportData?.attendanceSummary ?? buildHrMetrics(attendanceDetails),
    [reportData, attendanceDetails],
  )
  const maxDepartmentCount = Math.max(1, ...metrics.topDepartments.map((item) => item.count))
  const maxHourlyCount = Math.max(1, ...metrics.hourlyActivity.map((item) => item.count))
  const isEmployee = currentUser?.role === 'EMPLOYEE'

  useEffect(() => {
    if (isEmployee || targetMode !== 'employee') return

    const optionQuery = employeeSearch.split('|')[0]?.trim() || employeeSearch
    let cancelled = false
    fetchEmployeeOptions({ q: optionQuery, limit: 100 })
      .then((result) => {
        if (cancelled) return
        setEmployeeOptions(result.items.map(toEmployeeOption))
      })
      .catch(() => {
        if (!cancelled) setEmployeeOptions([])
      })

    return () => {
      cancelled = true
    }
  }, [currentUser?.userId, employeeSearch, isEmployee, targetMode])
  const activeTrend = trendItems(reportData?.workHours ?? null, trendMode)
  const maxAttendanceTrendCount = Math.max(1, ...dailyAttendanceTrend.map((item) => item.count))
  const maxTrendHours = Math.max(1, ...activeTrend.map((item) => item.averageHours))
  const trendChartWidth = 640
  const trendChartHeight = 154
  const trendChartPadding = { top: 22, right: 28, bottom: 34, left: 28 }
  const trendInnerWidth = trendChartWidth - trendChartPadding.left - trendChartPadding.right
  const trendInnerHeight = 82
  const attendanceTrendPoints = dailyAttendanceTrend.map((item, index) => {
    const x = trendChartPadding.left + (dailyAttendanceTrend.length <= 1 ? trendInnerWidth / 2 : (index / (dailyAttendanceTrend.length - 1)) * trendInnerWidth)
    const y = trendChartPadding.top + trendInnerHeight - (item.count / maxAttendanceTrendCount) * trendInnerHeight
    return { ...item, x, y }
  })
  const attendanceTrendPath = attendanceTrendPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
  const trendPoints = activeTrend.map((item, index) => {
    const x = trendChartPadding.left + (activeTrend.length <= 1 ? trendInnerWidth / 2 : (index / (activeTrend.length - 1)) * trendInnerWidth)
    const y = trendChartPadding.top + trendInnerHeight - (item.averageHours / maxTrendHours) * trendInnerHeight
    return { ...item, x, y }
  })
  const trendPath = trendPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
  const hourlyAxis = buildCountAxis(maxHourlyCount)
  const preparerName = currentUser?.displayName?.trim() || currentUser?.username || currentUser?.employeeId || '未知'
  const selectedEmployee = visibleEmployeeOptions.find((employee) => employee.employeeId === selectedEmployeeId)
  const targetLabel =
    targetMode === 'employee'
      ? selectedEmployee
        ? `${selectedEmployee.displayName} (${selectedEmployee.employeeId})`
        : selectedEmployeeId || '指定對象'
      : departmentId === 'ALL'
        ? '全部部門'
        : departmentId
  const reportSectionOptions: ReportSectionOptions = {
    coreKpi: showCoreKpi,
    attendanceRate: showCoreKpi && showAttendanceRate,
    periodAttendanceCount: showCoreKpi && showPeriodAttendanceCount,
    departmentStaySummary: !isEmployee && showOrganizationAnalysis && showDepartmentStaySummary,
    departmentStayRanking: !isEmployee && showOrganizationAnalysis && showDepartmentStayRanking,
    departmentAttendanceRate: !isEmployee && showDepartmentAttendanceRate,
    anomalySummary: showAnomalySummary,
    averageWorkHours: showCoreKpi && showAverageWorkHours,
    trendAnalysis: showTrendAnalysis,
    attendanceTrend: showTrendAnalysis && showAttendanceTrend,
    eventMetrics: showEventMetrics && Object.values(eventMetricOptions).some(Boolean),
    eventMetricOptions,
    workTrend: showTrendAnalysis && showWorkTrend,
    organizationAnalysis: !isEmployee && showOrganizationAnalysis,
    departmentDistribution: showOrganizationAnalysis && !isEmployee && showDepartmentDistribution,
    hourlyActivity: showTrendAnalysis && showHourlyActivity,
    eventDetails: showEventDetails,
    attendanceDetails: showAttendanceDetails,
  }
  const allReportOptionsSelected =
    showCoreKpi &&
    showAttendanceRate &&
    showPeriodAttendanceCount &&
    showAverageWorkHours &&
    showAnomalySummary &&
    showTrendAnalysis &&
    showAttendanceTrend &&
    showWorkTrend &&
    showHourlyActivity &&
    showOrganizationAnalysis &&
    showDepartmentStaySummary &&
    showDepartmentStayRanking &&
    (isEmployee || showDepartmentAttendanceRate) &&
    (isEmployee || showDepartmentDistribution) &&
    showEventMetrics &&
    Object.values(eventMetricOptions).every(Boolean) &&
    showEventDetails &&
    showAttendanceDetails &&
    Object.values(attendanceDetailOptions).every(Boolean)
  const setAllReportOptions = (checked: boolean) => {
    setShowCoreKpi(checked)
    setShowAttendanceRate(checked)
    setShowPeriodAttendanceCount(checked)
    setShowAverageWorkHours(checked)
    setShowAnomalySummary(checked)
    setShowTrendAnalysis(checked)
    setShowAttendanceTrend(checked)
    setShowWorkTrend(checked)
    setShowHourlyActivity(checked)
    setShowOrganizationAnalysis(checked)
    setShowDepartmentStaySummary(checked)
    setShowDepartmentStayRanking(checked)
    setShowDepartmentAttendanceRate(checked)
    setShowDepartmentDistribution(checked)
    setShowEventMetrics(checked)
    setEventMetricOptions({
      total: checked,
      granted: checked,
      denied: checked,
      deniedRate: checked,
      inCount: checked,
      outCount: checked,
      avgLatency: checked,
    })
    setShowEventDetails(checked)
    setShowAttendanceDetails(checked)
    setAttendanceDetailOptions({
      firstIn: checked,
      lastOut: checked,
      workHours: checked,
      inGate: checked,
      outGate: checked,
      anomalies: checked,
    })
  }
  const updateAttendanceDetailOption = (key: keyof AttendanceDetailOptions, checked: boolean) => {
    setAttendanceDetailOptions((current) => ({ ...current, [key]: checked }))
  }
  const updateEventMetricOption = (key: keyof EventMetricOptions, checked: boolean) => {
    setEventMetricOptions((current) => ({ ...current, [key]: checked }))
  }
  const selectEmployeeSearchValue = (value: string) => {
    setEmployeeSearch(value)
    const normalized = value.trim().toLowerCase()
    const matchedEmployee = visibleEmployeeOptions.find((employee) => {
      const label = employeeSearchLabel(employee).toLowerCase()
      return employee.employeeId.toLowerCase() === normalized || employee.displayName.toLowerCase() === normalized || label === normalized
    })
    if (matchedEmployee) {
      setTargetMode('employee')
      setSelectedEmployeeId(matchedEmployee.employeeId)
      return
    }

    const matchedDepartment = departmentOptions.find((department) => {
      const label = `${department.name} (${department.departmentId})`.toLowerCase()
      return department.departmentId.toLowerCase() === normalized || department.name.toLowerCase() === normalized || label === normalized
    })
    if (matchedDepartment) {
      setTargetMode('department')
      setDepartmentId(matchedDepartment.departmentId)
      setSelectedEmployeeId('')
      return
    }

    if (/^[A-Za-z0-9_-]+$/.test(value.trim())) {
      setTargetMode('employee')
      setSelectedEmployeeId(value.trim())
    } else {
      setSelectedEmployeeId('')
    }
  }

  const downloadReport = async () => {
    setIsDownloading(true)
    setMessage(null)

    try {
      const rangeFrom = liveFrom


      const result = await fetchReportCenterData({
        from: rangeFrom,
        to,
        departmentId: activeDepartmentId,
        employeeId: activeEmployeeId,
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

      const reportHtml = buildVisualReport(
        result.events,
        reportMetrics,
        result.workHours,
        buildAttendanceDetails(result.events),
        result.attendanceSummary ?? buildHrMetrics(buildAttendanceDetails(result.events)),
        rangeFrom,
        to,
        activeDepartmentId,
        targetLabel,
        preparerName,
        reportSectionOptions,
        attendanceDetailOptions,
        result.generationLatencyMs,
        result.attendanceTrend,
      )
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
          <div className="col-12">
            <label className="form-label">時間範圍</label>
            <div className="d-flex flex-wrap gap-2">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`btn btn-sm ${rangePreset === p.key ? 'btn-primary' : 'btn-outline-secondary'}`}
                  onClick={() => setRangePreset(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {rangePreset === 'custom' && (
              <div className="d-flex gap-2 align-items-center mt-2 flex-wrap">
                <input
                  type="date"
                  className="form-control form-control-sm w-auto"
                  value={customFrom}
                  max={customTo}
                  onChange={(e) => {
                    const newFrom = e.target.value
                    setCustomFrom(newFrom)
                    // if current to exceeds from+3months, clamp it
                    const maxTo = addMonths(newFrom, 3)
                    if (customTo > maxTo) setCustomTo(maxTo > todayValue ? todayValue : maxTo)
                  }}
                />
                <span className="text-secondary small">至</span>
                <input
                  type="date"
                  className="form-control form-control-sm w-auto"
                  value={customTo}
                  min={customFrom}
                  max={addMonths(customFrom, 3) < todayValue ? addMonths(customFrom, 3) : todayValue}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
                <span className="text-secondary small">（區間最大 3 個月）</span>
              </div>
            )}
            {rangePreset !== 'custom' && (
              <div className="small text-secondary mt-1">{liveFrom} 至 {to}</div>
            )}
          </div>
          {!isEmployee ? (
            <div className="col-md-3">
              <label className="form-label" htmlFor="report-department">部門 / 對象</label>
              <select
                id="report-department"
                className="form-select"
                value={targetMode === 'employee' ? '__EMPLOYEE__' : departmentId}
                onChange={(event) => {
                  if (event.target.value === '__EMPLOYEE__') {
                    setTargetMode('employee')
                    return
                  }
                  setTargetMode('department')
                  setDepartmentId(event.target.value)
                  setSelectedEmployeeId('')
                }}
              >
                <option value="__EMPLOYEE__">指定對象</option>
                <option value="ALL">全部部門</option>
                {departmentOptions.map((option) => (
                  <option key={option.departmentId} value={option.departmentId}>
                    {' '.repeat(option.depth * 2)}
                    {option.name} ({option.departmentId})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {!isEmployee && targetMode === 'employee' ? (
            <div className="col-md-3">
              <label className="form-label" htmlFor="report-employee-search">員工</label>
              <input
                id="report-employee-search"
                className="form-control"
                list="report-employee-options"
                placeholder="輸入員工編號或姓名"
                value={employeeSearch}
                onChange={(event) => selectEmployeeSearchValue(event.target.value)}
              />
              <datalist id="report-employee-options">
                {visibleEmployeeOptions.map((employee) => (
                  <option key={employee.employeeId} value={employeeSearchLabel(employee)} />
                ))}
              </datalist>
            </div>
          ) : null}
          <div className="col-12">
            <div className="report-section-options" aria-label="報表顯示項目">
              <span>報表顯示項目</span>
              <label>
                <input type="checkbox" checked={allReportOptionsSelected} onChange={(event) => setAllReportOptions(event.target.checked)} />
                全選
              </label>
              <label>
                <input type="checkbox" checked={showCoreKpi} onChange={(event) => setShowCoreKpi(event.target.checked)} />
                核心出勤 KPI
              </label>
              <label>
                <input type="checkbox" checked={showTrendAnalysis} onChange={(event) => setShowTrendAnalysis(event.target.checked)} />
                趨勢分析
              </label>
              {!isEmployee ? (
                <label>
                  <input type="checkbox" checked={showOrganizationAnalysis} onChange={(event) => setShowOrganizationAnalysis(event.target.checked)} />
                  組織分析
                </label>
              ) : null}
              <label>
                <input type="checkbox" checked={showAttendanceDetails} onChange={(event) => setShowAttendanceDetails(event.target.checked)} />
                出勤日明細
              </label>
              <label>
                <input type="checkbox" checked={showEventMetrics} onChange={(event) => setShowEventMetrics(event.target.checked)} />
                刷卡事件統計
              </label>
              <label>
                <input type="checkbox" checked={showEventDetails} onChange={(event) => setShowEventDetails(event.target.checked)} />
                刷卡事件明細
              </label>
              <button
                className="report-section-options-toggle"
                type="button"
                onClick={() => setShowReportOptionDetails((current) => !current)}
                aria-expanded={showReportOptionDetails}
              >
                {showReportOptionDetails ? '收起細項' : '展開細項'}
              </button>
              {showReportOptionDetails && showCoreKpi ? (
                <div className="report-section-options-subgroup" aria-label="核心出勤 KPI 指標">
                  <span>核心出勤 KPI</span>
                  <label>
                    <input type="checkbox" checked={showAttendanceRate} onChange={(event) => setShowAttendanceRate(event.target.checked)} />
                    期間正常出勤率
                  </label>
                  <label>
                    <input type="checkbox" checked={showPeriodAttendanceCount} onChange={(event) => setShowPeriodAttendanceCount(event.target.checked)} />
                    期間出勤人數
                  </label>
                  <label>
                    <input type="checkbox" checked={showAverageWorkHours} onChange={(event) => setShowAverageWorkHours(event.target.checked)} />
                    期間平均工時
                  </label>
                  <label>
                    <input type="checkbox" checked={showAnomalySummary} onChange={(event) => setShowAnomalySummary(event.target.checked)} />
                    期間異常天數
                  </label>
                </div>
              ) : null}
              {showReportOptionDetails && showTrendAnalysis ? (
                <div className="report-section-options-subgroup" aria-label="趨勢分析指標">
                  <span>趨勢分析</span>
                  <label>
                    <input type="checkbox" checked={showAttendanceTrend} onChange={(event) => setShowAttendanceTrend(event.target.checked)} />
                    期間出勤人數趨勢
                  </label>
                  <label>
                    <input type="checkbox" checked={showWorkTrend} onChange={(event) => setShowWorkTrend(event.target.checked)} />
                    工時趨勢
                  </label>
                  <label>
                    <input type="checkbox" checked={showHourlyActivity} onChange={(event) => setShowHourlyActivity(event.target.checked)} />
                    時段刷卡活動量
                  </label>
                </div>
              ) : null}
              {showReportOptionDetails && !isEmployee && showOrganizationAnalysis ? (
                <div className="report-section-options-subgroup" aria-label="組織分析指標">
                  <span>組織分析</span>
                  <label>
                    <input type="checkbox" checked={showDepartmentStaySummary} onChange={(event) => setShowDepartmentStaySummary(event.target.checked)} />
                    組織平均停留時數
                  </label>
                  <label>
                    <input type="checkbox" checked={showDepartmentStayRanking} onChange={(event) => setShowDepartmentStayRanking(event.target.checked)} />
                    部門停留時數排名
                  </label>
                  <label>
                    <input type="checkbox" checked={showDepartmentAttendanceRate} onChange={(event) => setShowDepartmentAttendanceRate(event.target.checked)} />
                    部門正常出勤率
                  </label>
                  <label>
                    <input type="checkbox" checked={showDepartmentDistribution} onChange={(event) => setShowDepartmentDistribution(event.target.checked)} />
                    部門刷卡事件分布
                  </label>
                </div>
              ) : null}
              {showReportOptionDetails && showAttendanceDetails ? (
                <div className="report-section-options-subgroup" aria-label="出勤日明細欄位">
                  <span>出勤日明細欄位</span>
                  <label>
                    <input type="checkbox" checked={attendanceDetailOptions.firstIn} onChange={(event) => updateAttendanceDetailOption('firstIn', event.target.checked)} />
                    上班
                  </label>
                  <label>
                    <input type="checkbox" checked={attendanceDetailOptions.inGate} onChange={(event) => updateAttendanceDetailOption('inGate', event.target.checked)} />
                    刷入門禁
                  </label>
                  <label>
                    <input type="checkbox" checked={attendanceDetailOptions.lastOut} onChange={(event) => updateAttendanceDetailOption('lastOut', event.target.checked)} />
                    下班
                  </label>
                  <label>
                    <input type="checkbox" checked={attendanceDetailOptions.outGate} onChange={(event) => updateAttendanceDetailOption('outGate', event.target.checked)} />
                    刷出門禁
                  </label>
                  <label>
                    <input type="checkbox" checked={attendanceDetailOptions.workHours} onChange={(event) => updateAttendanceDetailOption('workHours', event.target.checked)} />
                    工時
                  </label>
                  <label>
                    <input type="checkbox" checked={attendanceDetailOptions.anomalies} onChange={(event) => updateAttendanceDetailOption('anomalies', event.target.checked)} />
                    異常事件
                  </label>
                </div>
              ) : null}
              {showReportOptionDetails && showEventMetrics ? (
                <div className="report-section-options-subgroup" aria-label="刷卡事件統計指標">
                  <span>刷卡事件統計</span>
                  <label>
                    <input type="checkbox" checked={eventMetricOptions.total} onChange={(event) => updateEventMetricOption('total', event.target.checked)} />
                    期間事件總數
                  </label>
                  <label>
                    <input type="checkbox" checked={eventMetricOptions.granted} onChange={(event) => updateEventMetricOption('granted', event.target.checked)} />
                    允許通行數
                  </label>
                  <label>
                    <input type="checkbox" checked={eventMetricOptions.denied} onChange={(event) => updateEventMetricOption('denied', event.target.checked)} />
                    拒絕通行數
                  </label>
                  <label>
                    <input type="checkbox" checked={eventMetricOptions.deniedRate} onChange={(event) => updateEventMetricOption('deniedRate', event.target.checked)} />
                    拒絕率
                  </label>
                  <label>
                    <input type="checkbox" checked={eventMetricOptions.inCount} onChange={(event) => updateEventMetricOption('inCount', event.target.checked)} />
                    刷進次數
                  </label>
                  <label>
                    <input type="checkbox" checked={eventMetricOptions.outCount} onChange={(event) => updateEventMetricOption('outCount', event.target.checked)} />
                    刷出次數
                  </label>
                  <label>
                    <input type="checkbox" checked={eventMetricOptions.avgLatency} onChange={(event) => updateEventMetricOption('avgLatency', event.target.checked)} />
                    刷卡平均延遲
                  </label>
                </div>
              ) : null}
            </div>
          </div>
          <div className="col-12 report-condition-footer">
            {message ? <div className="small text-secondary">{message}</div> : <div />}
            <div className="small text-secondary">
              頁面資料產製耗時：{reportData?.generationLatencyMs == null ? '-' : `${reportData.generationLatencyMs.toFixed(1)} ms`}
            </div>
          </div>
        </div>
      </section>

      {showCoreKpi && (showAttendanceRate || showPeriodAttendanceCount || showAverageWorkHours || showAnomalySummary) ? (
        <section className="kpi-grid">
          {showAttendanceRate ? (
            <div className="kpi-card">
              <div className="kpi-label">期間正常出勤率</div>
              <div className="kpi-value">{isLoading ? '-' : formatPercentValue(hrMetrics.normalAttendanceRate)}</div>
              <div className="kpi-footnote">完整上下班且無異常</div>
            </div>
          ) : null}
          {showPeriodAttendanceCount ? (
            <div className="kpi-card">
              <div className="kpi-label">期間出勤人數</div>
              <div className="kpi-value">{isLoading ? '-' : hrMetrics.periodAttendanceCount.toLocaleString()}</div>
              <div className="kpi-footnote">至少有一次上班刷卡</div>
            </div>
          ) : null}
          {showAverageWorkHours ? (
            <div className="kpi-card">
              <div className="kpi-label">期間平均工時</div>
              <div className="kpi-value">{isLoading ? '-' : formatHours(hrMetrics.averageStayHours)}</div>
              <div className="kpi-footnote">完整進出紀錄平均</div>
            </div>
          ) : null}
          {showAnomalySummary ? (
            <div className="kpi-card">
              <div className="kpi-label">期間異常天數</div>
              <div className="kpi-value">{isLoading ? '-' : hrMetrics.anomalyDays.toLocaleString()}</div>
              <div className="kpi-footnote">拒絕通行或缺少上下班</div>
            </div>
          ) : null}
        </section>
      ) : null}

      {!isEmployee && showOrganizationAnalysis && showDepartmentStaySummary ? (
        <section className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">組織平均停留時數</div>
            <div className="kpi-value">{isLoading ? '-' : formatHours(hrMetrics.averageStayHours)}</div>
            <div className="kpi-footnote">依刷進到刷出估算</div>
          </div>
        </section>
      ) : null}

      {!isEmployee && showOrganizationAnalysis && showDepartmentStayRanking ? (
        <section className="panel-card mb-3">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h2 className="h6 m-0">部門停留時數排名</h2>
            <span className="small text-secondary">所選期間，依總停留時數排序</span>
          </div>
          <div className="table-responsive">
            <table className="table-clean">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>部門</th>
                  <th>總停留時數</th>
                  <th>平均停留時數</th>
                  <th>人數</th>
                  <th>正常出勤率</th>
                </tr>
              </thead>
              <tbody>
                {hrMetrics.departmentStayStats.length > 0 ? (
                  hrMetrics.departmentStayStats.slice(0, 10).map((item, index) => (
                    <tr key={item.departmentId}>
                      <td>{index + 1}</td>
                      <td>{item.departmentId}</td>
                      <td>{formatHours(item.totalHours)}</td>
                      <td>{formatHours(item.averageHours)}</td>
                      <td>{item.employeeCount.toLocaleString()}</td>
                      <td>{formatPercentValue(item.normalAttendanceRate)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="text-secondary text-center py-4">
                      {isLoading ? '載入中...' : '這段期間沒有部門停留時數資料'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {!isEmployee && showOrganizationAnalysis && showDepartmentAttendanceRate ? (
        <section className="panel-card mb-3">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h2 className="h6 m-0">部門正常出勤率</h2>
            <span className="small text-secondary">所選期間，完整上下班且無異常</span>
          </div>
          <div className="table-responsive">
            <table className="table-clean">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>部門</th>
                  <th>正常出勤率</th>
                  <th>有效出勤日數</th>
                </tr>
              </thead>
              <tbody>
                {hrMetrics.departmentStayStats.length > 0 ? (
                  [...hrMetrics.departmentStayStats]
                    .sort((a, b) => (b.normalAttendanceRate ?? -1) - (a.normalAttendanceRate ?? -1))
                    .slice(0, 10)
                    .map((item, index) => (
                      <tr key={item.departmentId}>
                        <td>{index + 1}</td>
                        <td>{item.departmentId}</td>
                        <td>{formatPercentValue(item.normalAttendanceRate)}</td>
                        <td>{item.workDays.toLocaleString()}</td>
                      </tr>
                    ))
                ) : (
                  <tr>
                    <td colSpan={4} className="text-secondary text-center py-4">
                      {isLoading ? '載入中...' : '這段期間沒有部門出勤率資料'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {showAttendanceDetails ? (
        <section className="panel-card mb-3">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h2 className="h6 m-0">出勤日明細</h2>
            <span className="small text-secondary">依日期與員工彙整</span>
          </div>
          <div className="table-responsive">
            <table className="table-clean">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>員工編號</th>
                  <th>姓名</th>
                  <th>部門</th>
                  {attendanceDetailOptions.firstIn ? <th>上班</th> : null}
                  {attendanceDetailOptions.inGate ? <th>刷入門禁</th> : null}
                  {attendanceDetailOptions.lastOut ? <th>下班</th> : null}
                  {attendanceDetailOptions.outGate ? <th>刷出門禁</th> : null}
                  {attendanceDetailOptions.workHours ? <th>工時</th> : null}
                  {attendanceDetailOptions.anomalies ? <th>異常事件</th> : null}
                </tr>
              </thead>
              <tbody>
                {attendanceDetails.length > 0 ? (
                  attendanceDetails.slice(0, 20).map((item) => {
                    const anomalyText = item.anomalies.length > 0 ? item.anomalies.slice(0, 2).map((event) => `${localTimeText(event.timestamp)} ${event.reason || event.decision}`).join('；') : '-'
                    return (
                      <tr key={item.key}>
                        <td>{item.date}</td>
                        <td>{item.employeeId}</td>
                        <td>{item.displayName || '-'}</td>
                        <td>{item.departmentId}</td>
                        {attendanceDetailOptions.firstIn ? <td>{localTimeText(item.firstIn?.timestamp)}</td> : null}
                        {attendanceDetailOptions.inGate ? <td>{item.firstIn?.gateId ?? '-'}</td> : null}
                        {attendanceDetailOptions.lastOut ? <td>{localTimeText(item.lastOut?.timestamp)}</td> : null}
                        {attendanceDetailOptions.outGate ? <td>{item.lastOut?.gateId ?? '-'}</td> : null}
                        {attendanceDetailOptions.workHours ? <td>{formatHours(item.workHours)}</td> : null}
                        {attendanceDetailOptions.anomalies ? <td className={item.anomalies.length > 0 ? 'danger-text' : undefined}>{anomalyText}</td> : null}
                      </tr>
                    )
                  })
                ) : (
                  <tr>
                    <td colSpan={4 + Object.values(attendanceDetailOptions).filter(Boolean).length} className="text-secondary text-center py-4">
                      {isLoading ? '載入中...' : '這段期間沒有出勤明細'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {showEventMetrics && Object.values(eventMetricOptions).some(Boolean) ? (
        <section className="panel-card report-event-metrics-panel mb-3">
          <h2 className="report-static-section-title">刷卡事件統計</h2>
          <div className="report-event-metrics-grid">
            {eventMetricOptions.total ? (
              <div>
                <span>期間事件總數</span>
                <strong>{metrics.total.toLocaleString()}</strong>
              </div>
            ) : null}
            {eventMetricOptions.granted ? (
              <div>
                <span>允許通行數</span>
                <strong>{metrics.granted.toLocaleString()}</strong>
              </div>
            ) : null}
            {eventMetricOptions.denied ? (
              <div>
                <span>拒絕通行數</span>
                <strong>{metrics.denied.toLocaleString()}</strong>
              </div>
            ) : null}
            {eventMetricOptions.deniedRate ? (
              <div>
                <span>拒絕率</span>
                <strong>{formatDeniedRate(metrics.deniedRate, metrics.denied)}</strong>
              </div>
            ) : null}
            {eventMetricOptions.inCount ? (
              <div>
                <span>刷進次數</span>
                <strong>{metrics.inCount.toLocaleString()}</strong>
              </div>
            ) : null}
            {eventMetricOptions.outCount ? (
              <div>
                <span>刷出次數</span>
                <strong>{metrics.outCount.toLocaleString()}</strong>
              </div>
            ) : null}
            {eventMetricOptions.avgLatency ? (
              <div>
                <span>刷卡平均延遲</span>
                <strong>{metrics.avgLatencyMs === null ? '-' : `${metrics.avgLatencyMs.toLocaleString()} ms`}</strong>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {showTrendAnalysis && showAttendanceTrend ? (
        <section className="panel-card work-trend-panel mb-3">
          <div className="report-section-toolbar">
            <h2 className="h6 m-0">期間出勤人數趨勢</h2>
            <span className="small text-secondary">每日不重複出勤人數</span>
          </div>
          <div className="work-trend-chart">
            {dailyAttendanceTrend.length > 0 ? (
              <svg className="work-trend-line" viewBox={`0 0 ${trendChartWidth} ${trendChartHeight}`} role="img" aria-label="期間出勤人數趨勢">
                {[0, 0.5, 1].map((ratio) => {
                  const y = trendChartPadding.top + trendInnerHeight - ratio * trendInnerHeight
                  return <line className="work-trend-grid-line" key={ratio} x1={trendChartPadding.left} x2={trendChartWidth - trendChartPadding.right} y1={y} y2={y} />
                })}
                {attendanceTrendPoints.length > 1 ? <path className="work-trend-path" d={attendanceTrendPath} /> : null}
                {attendanceTrendPoints.map((point: DailyAttendanceTrendPoint & { x: number; y: number }) => (
                  <g key={point.label}>
                    <circle className="work-trend-point" cx={point.x} cy={point.y} r="4" />
                    <text className="work-trend-value" x={point.x} y={Math.max(14, point.y - 10)}>
                      {point.count.toLocaleString()}
                    </text>
                    <text className="work-trend-label" x={point.x} y={trendChartHeight - 16}>
                      {point.label.slice(5)}
                    </text>
                  </g>
                ))}
              </svg>
            ) : (
              <div className="work-trend-empty text-secondary small">目前沒有可計算的出勤趨勢資料。</div>
            )}
          </div>
        </section>
      ) : null}

      {showTrendAnalysis && showWorkTrend ? (
        <section className="panel-card work-trend-panel mb-3">
          <div className="report-section-toolbar">
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
      ) : null}

      {!isEmployee && showOrganizationAnalysis && showDepartmentDistribution ? (
        <section className="panel-grid mb-3">
          <div className="panel-card">
          <div className="report-section-toolbar">
            <h2 className="h6 m-0">部門刷卡事件分布</h2>
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
        </section>
      ) : null}

      {showTrendAnalysis && showHourlyActivity ? (
        <section className="panel-card report-event-metrics-panel mb-3">
          <div className="report-section-toolbar">
            <h2 className="report-static-section-title">時段刷卡活動量</h2>
            <span className="small text-secondary">所選期間，台北時間</span>
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
      ) : null}

      {showEventDetails ? (
        <section className="panel-card mb-3">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h2 className="h6 m-0">事件明細</h2>
            <span className="small text-secondary">共 {eventTableTotal.toLocaleString()} 筆</span>
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
                {eventTableLoading ? (
                  <tr><td colSpan={6} className="text-secondary text-center py-4">載入中...</td></tr>
                ) : eventTableItems.length > 0 ? (
                  eventTableItems.map((event) => (
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
                      這段期間沒有事件資料
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {eventTableTotal > EVENT_TABLE_PAGE_SIZE && (
            <div className="d-flex justify-content-between align-items-center mt-2 small text-secondary">
              <span>第 {eventTableOffset + 1}–{Math.min(eventTableOffset + EVENT_TABLE_PAGE_SIZE, eventTableTotal)} 筆，共 {eventTableTotal.toLocaleString()} 筆</span>
              <div className="d-flex gap-2">
                <button className="btn btn-sm btn-outline-secondary" type="button" disabled={eventTableOffset === 0 || eventTableLoading} onClick={() => setEventTableOffset((o) => Math.max(0, o - EVENT_TABLE_PAGE_SIZE))}>← 上一頁</button>
                <button className="btn btn-sm btn-outline-secondary" type="button" disabled={eventTableOffset + EVENT_TABLE_PAGE_SIZE >= eventTableTotal || eventTableLoading} onClick={() => setEventTableOffset((o) => o + EVENT_TABLE_PAGE_SIZE)}>下一頁 →</button>
              </div>
            </div>
          )}
        </section>
      ) : null}

      {showAttendanceDetails ? (
        <section className="panel-card">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h2 className="h6 m-0">出勤日明細</h2>
            <span className="small text-secondary">共 {attendanceDetails.length} 筆</span>
          </div>
          <div className="table-responsive">
            <table className="table-clean">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>員工編號</th>
                  <th>姓名</th>
                  <th>部門</th>
                  {attendanceDetailOptions.firstIn ? <th>上班</th> : null}
                  {attendanceDetailOptions.inGate ? <th>刷入門禁</th> : null}
                  {attendanceDetailOptions.lastOut ? <th>下班</th> : null}
                  {attendanceDetailOptions.outGate ? <th>刷出門禁</th> : null}
                  {attendanceDetailOptions.workHours ? <th>工時</th> : null}
                  {attendanceDetailOptions.anomalies ? <th>異常事件</th> : null}
                </tr>
              </thead>
              <tbody>
                {attendanceDetails.length > 0 ? (
                  attendanceDetails.slice(attendancePage * 20, attendancePage * 20 + 20).map((item) => {
                    const anomalyText = item.anomalies.length > 0 ? item.anomalies.slice(0, 2).map((event) => `${localTimeText(event.timestamp)} ${event.reason || event.decision}`).join('；') : '-'
                    return (
                      <tr key={item.key}>
                        <td>{item.date}</td>
                        <td>{item.employeeId}</td>
                        <td>{item.displayName || '-'}</td>
                        <td>{item.departmentId}</td>
                        {attendanceDetailOptions.firstIn ? <td>{localTimeText(item.firstIn?.timestamp)}</td> : null}
                        {attendanceDetailOptions.inGate ? <td>{item.firstIn?.gateId ?? '-'}</td> : null}
                        {attendanceDetailOptions.lastOut ? <td>{localTimeText(item.lastOut?.timestamp)}</td> : null}
                        {attendanceDetailOptions.outGate ? <td>{item.lastOut?.gateId ?? '-'}</td> : null}
                        {attendanceDetailOptions.workHours ? <td>{formatHours(item.workHours)}</td> : null}
                        {attendanceDetailOptions.anomalies ? <td className={item.anomalies.length > 0 ? 'danger-text' : undefined}>{anomalyText}</td> : null}
                      </tr>
                    )
                  })
                ) : (
                  <tr>
                    <td colSpan={4 + Object.values(attendanceDetailOptions).filter(Boolean).length} className="text-secondary text-center py-4">
                      {isLoading ? '載入中...' : '這段期間沒有出勤明細'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {attendanceDetails.length > 20 && (
            <div className="d-flex justify-content-between align-items-center mt-2 small text-secondary">
              <span>第 {attendancePage * 20 + 1}–{Math.min(attendancePage * 20 + 20, attendanceDetails.length)} 筆，共 {attendanceDetails.length} 筆</span>
              <div className="d-flex gap-2">
                <button className="btn btn-sm btn-outline-secondary" type="button" disabled={attendancePage === 0} onClick={() => setAttendancePage((p) => p - 1)}>← 上一頁</button>
                <button className="btn btn-sm btn-outline-secondary" type="button" disabled={(attendancePage + 1) * 20 >= attendanceDetails.length} onClick={() => setAttendancePage((p) => p + 1)}>下一頁 →</button>
              </div>
            </div>
          )}
        </section>
      ) : null}
    </AppShell>
  )
}

export default Reports
