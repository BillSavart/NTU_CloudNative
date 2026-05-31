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

type ReportSectionOptions = {
  attendanceRate: boolean
  todayAttendance: boolean
  departmentStaySummary: boolean
  departmentStayRanking: boolean
  anomalySummary: boolean
  averageWorkHours: boolean
  eventMetrics: boolean
  workTrend: boolean
  departmentDistribution: boolean
  hourlyActivity: boolean
  eventDetails: boolean
  attendanceDetails: boolean
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
}

type HrMetrics = {
  attendanceRate: number | null
  normalAttendanceRate: number | null
  todayAttendanceCount: number
  anomalyDays: number
  averageStayHours: number | null
  departmentStayStats: DepartmentStayStat[]
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
// the picker can be widened up to LIVE_VIEW_MONTHS. Older data is pulled only on
// explicit download. Keep this in sync with the backend report-center cache,
// which caches windowed calls.
const LIVE_VIEW_MONTHS = 3
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

// Earliest date the on-page preview may reach (the picker's lower bound).
function earliestLiveDate() {
  return monthsAgoDate(LIVE_VIEW_MONTHS)
}

// Default preview window on first load — small, so the cold fetch is light.
function defaultFromDate() {
  return daysAgoDate(LIVE_VIEW_DEFAULT_DAYS)
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

function buildHrMetrics(attendanceDetails: AttendanceDetailRow[]): HrMetrics {
  const totalRows = attendanceDetails.length
  const attendedRows = attendanceDetails.filter((row) => row.firstIn).length
  const normalRows = attendanceDetails.filter((row) => row.firstIn && row.lastOut && row.anomalies.length === 0).length
  const anomalyDays = attendanceDetails.filter((row) => row.anomalies.length > 0 || !row.firstIn || !row.lastOut).length
  const today = localDateInputValue(new Date())
  const todayAttendanceCount = new Set(attendanceDetails.filter((row) => row.date === today && row.firstIn).map((row) => row.employeeId)).size
  const stayRows = attendanceDetails.filter((row) => typeof row.workHours === 'number')
  const totalStayHours = stayRows.reduce((sum, row) => sum + (row.workHours ?? 0), 0)
  const departments = new Map<string, { totalHours: number; workDays: number; employees: Set<string> }>()

  for (const row of stayRows) {
    const departmentId = row.departmentId || '-'
    const stat = departments.get(departmentId) ?? { totalHours: 0, workDays: 0, employees: new Set<string>() }
    stat.totalHours += row.workHours ?? 0
    stat.workDays += 1
    stat.employees.add(row.employeeId)
    departments.set(departmentId, stat)
  }

  return {
    attendanceRate: totalRows > 0 ? (attendedRows / totalRows) * 100 : null,
    normalAttendanceRate: totalRows > 0 ? (normalRows / totalRows) * 100 : null,
    todayAttendanceCount,
    anomalyDays,
    averageStayHours: stayRows.length > 0 ? totalStayHours / stayRows.length : null,
    departmentStayStats: [...departments.entries()]
      .map(([departmentId, stat]) => ({
        departmentId,
        totalHours: stat.totalHours,
        averageHours: stat.workDays > 0 ? stat.totalHours / stat.workDays : null,
        workDays: stat.workDays,
        employeeCount: stat.employees.size,
      }))
      .sort((a, b) => b.totalHours - a.totalHours),
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

async function fetchAccessEventsForCsv(from: string, to: string, departmentId: string, employeeId?: string) {
  const pageSize = 200
  const maxRows = 5000
  const pages: AccessEvent[] = []

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const result = await fetchAccessEvents({
      from,
      to,
      departmentId,
      employeeId,
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
    return '<tr><td colspan="5" class="empty">這段期間沒有部門停留時數資料</td></tr>'
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
) {
  const generatedAt = new Date().toLocaleString('zh-TW', { hour12: false })
  const deptPart = departmentId === 'ALL' ? '全部部門' : departmentId
  const generationLatencyText = typeof generationLatencyMs === 'number' ? `${generationLatencyMs.toFixed(1)}ms` : '-'

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
    <div class="meta">期間：${htmlEscape(from)} 至 ${htmlEscape(to)} | 範圍：${htmlEscape(deptPart)} | 報表對象：${htmlEscape(targetLabel)} | 製表人：${htmlEscape(preparerName)} | 產生時間：${htmlEscape(generatedAt)} | 此次報表產製耗時：${htmlEscape(generationLatencyText)}</div>
    ${
      sectionOptions.attendanceRate || sectionOptions.todayAttendance || sectionOptions.departmentStaySummary || sectionOptions.anomalySummary
        ? `<h2>HR 出勤重點</h2><div class="metrics">
            ${sectionOptions.attendanceRate ? metricLine('正常出勤率', formatPercentValue(hrMetrics.normalAttendanceRate)) : ''}
            ${sectionOptions.todayAttendance ? metricLine('今日出勤人數', hrMetrics.todayAttendanceCount) : ''}
            ${sectionOptions.departmentStaySummary ? metricLine('平均停留時數', formatHours(hrMetrics.averageStayHours)) : ''}
            ${sectionOptions.anomalySummary ? metricLine('異常天數', hrMetrics.anomalyDays) : ''}
          </div>`
        : ''
    }
    ${
      sectionOptions.departmentStayRanking
        ? `<h2>部門停留時數排名</h2>
          <table>
            <thead><tr><th>排名</th><th>部門</th><th>總停留時數</th><th>平均停留時數</th><th>人數</th></tr></thead>
            <tbody>${departmentStayRows(hrMetrics.departmentStayStats)}</tbody>
          </table>`
        : ''
    }
    ${sectionOptions.averageWorkHours ? `<div class="metrics">${metricLine('平均工時', formatHours(workHours?.averageHours))}</div>` : ''}
    ${
      sectionOptions.eventMetrics
        ? `<h2>刷卡事件指標</h2><div class="metrics">
            ${metricLine('事件總數', metrics.total)}
            ${metricLine('允許通行', metrics.granted)}
            ${metricLine('拒絕通行', metrics.denied)}
            ${metricLine('拒絕率', formatDeniedRate(metrics.deniedRate, metrics.denied))}
            ${metricLine('刷進', metrics.inCount)}
            ${metricLine('刷出', metrics.outCount)}
            ${metricLine('刷卡平均延遲', metrics.avgLatencyMs === null ? '-' : `${metrics.avgLatencyMs} ms`)}
            ${metricLine('頁面資料產製耗時', typeof generationLatencyMs === 'number' ? `${generationLatencyMs.toFixed(1)} ms` : '-')}
          </div>`
        : ''
    }
    ${
      sectionOptions.workTrend
        ? `<h2>月工時趨勢</h2>
          <div class="chart">${lineTrendChart(workHours?.monthlyTrend ?? [])}</div>
          <h2>季工時趨勢</h2>
          <div class="chart">${lineTrendChart(workHours?.quarterlyTrend ?? [])}</div>
          <h2>年工時趨勢</h2>
          <div class="chart">${lineTrendChart(workHours?.yearlyTrend ?? [])}</div>`
        : ''
    }
    ${
      sectionOptions.departmentDistribution
        ? `<h2>部門事件分布</h2><div class="chart">${barRows(metrics.topDepartments.map((item) => ({ label: item.departmentId, value: item.count })))}</div>`
        : ''
    }
    ${sectionOptions.hourlyActivity ? `<h2>時段活動量</h2><div class="chart">${stackedHourRows(metrics.hourlyActivity)}</div>` : ''}
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

function Reports() {
  const [from, setFrom] = useState(defaultFromDate)
  const [to, setTo] = useState(() => localDateInputValue(new Date()))
  const [downloadHistorical, setDownloadHistorical] = useState(false)
  const [downloadFrom, setDownloadFrom] = useState(defaultFromDate)
  const [targetMode, setTargetMode] = useState<ReportTargetMode>('department')
  const [departmentId, setDepartmentId] = useState('ALL')
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')
  const [downloadContent, setDownloadContent] = useState<DownloadContent>('visual')
  const [trendMode, setTrendMode] = useState<TrendMode>('monthly')
  const [events, setEvents] = useState<AccessEvent[]>([])
  const [reportData, setReportData] = useState<ReportCenterResponse | null>(null)
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOption[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isDownloading, setIsDownloading] = useState(false)
  const [showAttendanceRate, setShowAttendanceRate] = useState(true)
  const [showTodayAttendance, setShowTodayAttendance] = useState(true)
  const [showDepartmentStaySummary, setShowDepartmentStaySummary] = useState(true)
  const [showDepartmentStayRanking, setShowDepartmentStayRanking] = useState(true)
  const [showAnomalySummary, setShowAnomalySummary] = useState(true)
  const [showAverageWorkHours, setShowAverageWorkHours] = useState(true)
  const [showEventMetrics, setShowEventMetrics] = useState(true)
  const [showWorkTrend, setShowWorkTrend] = useState(true)
  const [showDepartmentDistribution, setShowDepartmentDistribution] = useState(true)
  const [showHourlyActivity, setShowHourlyActivity] = useState(true)
  const [showEventDetails, setShowEventDetails] = useState(true)
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
  const activeEmployeeId = targetMode === 'employee' && selectedEmployeeId.trim() ? selectedEmployeeId.trim() : undefined
  const activeDepartmentId = targetMode === 'department' ? departmentId : 'ALL'
  const todayValue = localDateInputValue(new Date())
  const liveMinDate = earliestLiveDate()
  // The on-page preview window is always clamped to the last LIVE_VIEW_MONTHS so
  // the live fetch (and its cache key) stay bounded. Downloads can reach further
  // back via the historical override below.
  const liveFrom = from < liveMinDate ? liveMinDate : from
  const downloadFromEffective = downloadHistorical ? downloadFrom : liveFrom

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setMessage(null)

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
  const employeeOptions = useMemo(() => buildEmployeeOptions(events), [events])
  const hrMetrics = useMemo(() => buildHrMetrics(attendanceDetails), [attendanceDetails])
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
  const preparerName = currentUser?.displayName?.trim() || currentUser?.username || currentUser?.employeeId || '未知'
  const selectedEmployee = employeeOptions.find((employee) => employee.employeeId === selectedEmployeeId)
  const targetLabel =
    targetMode === 'employee'
      ? selectedEmployee
        ? `${selectedEmployee.displayName} (${selectedEmployee.employeeId})`
        : selectedEmployeeId || '指定員工'
      : departmentId === 'ALL'
        ? '全部部門'
        : departmentId
  const reportSectionOptions: ReportSectionOptions = {
    attendanceRate: showAttendanceRate,
    todayAttendance: showTodayAttendance,
    departmentStaySummary: showDepartmentStaySummary,
    departmentStayRanking: showDepartmentStayRanking,
    anomalySummary: showAnomalySummary,
    averageWorkHours: showAverageWorkHours,
    eventMetrics: showEventMetrics,
    workTrend: showWorkTrend,
    departmentDistribution: !isEmployee && showDepartmentDistribution,
    hourlyActivity: showHourlyActivity,
    eventDetails: showEventDetails,
    attendanceDetails: showAttendanceDetails,
  }
  const allReportOptionsSelected =
    showAttendanceRate &&
    showTodayAttendance &&
    showDepartmentStaySummary &&
    showDepartmentStayRanking &&
    showAnomalySummary &&
    showAverageWorkHours &&
    showEventMetrics &&
    showWorkTrend &&
    (isEmployee || showDepartmentDistribution) &&
    showHourlyActivity &&
    showEventDetails &&
    showAttendanceDetails &&
    Object.values(attendanceDetailOptions).every(Boolean)
  const setAllReportOptions = (checked: boolean) => {
    setShowAttendanceRate(checked)
    setShowTodayAttendance(checked)
    setShowDepartmentStaySummary(checked)
    setShowDepartmentStayRanking(checked)
    setShowAnomalySummary(checked)
    setShowAverageWorkHours(checked)
    setShowEventMetrics(checked)
    setShowWorkTrend(checked)
    setShowDepartmentDistribution(checked)
    setShowHourlyActivity(checked)
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
  const selectEmployeeSearchValue = (value: string) => {
    setEmployeeSearch(value)
    const normalized = value.trim().toLowerCase()
    const matchedEmployee = employeeOptions.find((employee) => {
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
      const deptPart = activeEmployeeId ? `employee-${activeEmployeeId}` : activeDepartmentId === 'ALL' ? 'all' : activeDepartmentId.toLowerCase()
      // Downloads may reach further back than the on-screen preview when the
      // historical override is enabled; otherwise they match the live window.
      const rangeFrom = downloadFromEffective

      if (downloadContent === 'raw') {
        const eventsForCsv = await fetchAccessEventsForCsv(rangeFrom, to, activeDepartmentId, activeEmployeeId)
        const csv = toCsv(eventsForCsv)
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `access-events-${deptPart}-${rangeFrom}-to-${to}.csv`
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
        setMessage(`已下載原始資料 CSV，共 ${eventsForCsv.length} 筆。`)
        return
      }

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
        buildHrMetrics(buildAttendanceDetails(result.events)),
        rangeFrom,
        to,
        activeDepartmentId,
        targetLabel,
        preparerName,
        reportSectionOptions,
        attendanceDetailOptions,
        result.generationLatencyMs,
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
          <div className="col-md-3">
            <label className="form-label" htmlFor="report-from-date">起始日期</label>
            <input id="report-from-date" className="form-control" type="date" min={liveMinDate} max={to} value={from} onChange={(event) => setFrom(event.target.value < liveMinDate ? liveMinDate : event.target.value)} />
          </div>
          <div className="col-md-3">
            <label className="form-label" htmlFor="report-to-date">結束日期</label>
            <input id="report-to-date" className="form-control" type="date" min={liveMinDate} max={todayValue} value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="col-12">
            <div className="form-check">
              <input
                id="report-download-historical"
                className="form-check-input"
                type="checkbox"
                checked={downloadHistorical}
                onChange={(event) => setDownloadHistorical(event.target.checked)}
              />
              <label className="form-check-label" htmlFor="report-download-historical">
                下載更早資料（超過近三個月）
              </label>
            </div>
            {downloadHistorical ? (
              <div className="row g-3 align-items-end mt-1">
                <div className="col-md-3">
                  <label className="form-label" htmlFor="report-download-from">下載起始日期</label>
                  <input id="report-download-from" className="form-control" type="date" max={to} value={downloadFrom} onChange={(event) => setDownloadFrom(event.target.value)} />
                </div>
              </div>
            ) : null}
            <div className="small text-secondary mt-1">
              頁面預覽僅顯示近三個月，載入較快；如需更早的資料，請勾選「下載更早資料」設定起始日期後按「下載報表」。
            </div>
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
                <option value="__EMPLOYEE__">指定員工</option>
                <option value="ALL">全部部門</option>
                {departmentOptions.map((option) => (
                  <option key={option.departmentId} value={option.departmentId}>
                    {'\u00A0'.repeat(option.depth * 2)}
                    {option.name} ({option.departmentId})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {!isEmployee && targetMode === 'employee' ? (
            <div className="col-md-3">
              <label className="form-label" htmlFor="report-employee-search">指定員工 / 部門</label>
              <input
                id="report-employee-search"
                className="form-control"
                list="report-employee-options"
                placeholder="輸入員工編號、姓名或部門"
                value={employeeSearch}
                onChange={(event) => selectEmployeeSearchValue(event.target.value)}
              />
              <datalist id="report-employee-options">
                {employeeOptions.map((employee) => (
                  <option key={employee.employeeId} value={employeeSearchLabel(employee)} />
                ))}
                {departmentOptions.map((department) => (
                  <option key={department.departmentId} value={`${department.name} (${department.departmentId})`} />
                ))}
              </datalist>
            </div>
          ) : null}
          <div className="col-md-3">
            <label className="form-label" htmlFor="report-download-content">下載內容</label>
            <select id="report-download-content" className="form-select" value={downloadContent} onChange={(event) => setDownloadContent(event.target.value as DownloadContent)}>
              <option value="visual">{isEmployee ? '我的報表' : '出勤趨勢報表'}</option>
              <option value="raw">原始事件資料 CSV</option>
            </select>
          </div>
          <div className="col-12">
            <div className="report-section-options" aria-label="報表顯示項目">
              <span>報表顯示項目</span>
              <label>
                <input type="checkbox" checked={allReportOptionsSelected} onChange={(event) => setAllReportOptions(event.target.checked)} />
                全選
              </label>
              <label>
                <input type="checkbox" checked={showAttendanceRate} onChange={(event) => setShowAttendanceRate(event.target.checked)} />
                正常出勤率
              </label>
              <label>
                <input type="checkbox" checked={showTodayAttendance} onChange={(event) => setShowTodayAttendance(event.target.checked)} />
                今日出勤人數
              </label>
              <label>
                <input type="checkbox" checked={showDepartmentStaySummary} onChange={(event) => setShowDepartmentStaySummary(event.target.checked)} />
                停留時數統計
              </label>
              <label>
                <input type="checkbox" checked={showDepartmentStayRanking} onChange={(event) => setShowDepartmentStayRanking(event.target.checked)} />
                部門停留時數排名
              </label>
              <label>
                <input type="checkbox" checked={showAnomalySummary} onChange={(event) => setShowAnomalySummary(event.target.checked)} />
                異常狀況
              </label>
              <label>
                <input type="checkbox" checked={showAverageWorkHours} onChange={(event) => setShowAverageWorkHours(event.target.checked)} />
                平均工時
              </label>
              <label>
                <input type="checkbox" checked={showEventMetrics} onChange={(event) => setShowEventMetrics(event.target.checked)} />
                刷卡事件指標
              </label>
              <label>
                <input type="checkbox" checked={showWorkTrend} onChange={(event) => setShowWorkTrend(event.target.checked)} />
                工時趨勢
              </label>
              {!isEmployee ? (
                <label>
                  <input type="checkbox" checked={showDepartmentDistribution} onChange={(event) => setShowDepartmentDistribution(event.target.checked)} />
                  部門事件分布
                </label>
              ) : null}
              <label>
                <input type="checkbox" checked={showHourlyActivity} onChange={(event) => setShowHourlyActivity(event.target.checked)} />
                時段活動量
              </label>
              <label>
                <input type="checkbox" checked={showEventDetails} onChange={(event) => setShowEventDetails(event.target.checked)} />
                事件明細
              </label>
              <label>
                <input type="checkbox" checked={showAttendanceDetails} onChange={(event) => setShowAttendanceDetails(event.target.checked)} />
                出勤日明細
              </label>
              {showAttendanceDetails ? (
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
            </div>
          </div>          {message && <div className="col-12 small text-secondary text-end">{message}</div>}
        </div>
      </section>

      {showAttendanceRate || showTodayAttendance || showDepartmentStaySummary || showAnomalySummary ? (
        <section className="kpi-grid">
          {showAttendanceRate ? (
            <div className="kpi-card">
              <div className="kpi-label">正常出勤率</div>
              <div className="kpi-value">{isLoading ? '-' : formatPercentValue(hrMetrics.normalAttendanceRate)}</div>
              <div className="kpi-footnote">完整上下班且無異常</div>
            </div>
          ) : null}
          {showTodayAttendance ? (
            <div className="kpi-card">
              <div className="kpi-label">今日出勤人數</div>
              <div className="kpi-value">{isLoading ? '-' : hrMetrics.todayAttendanceCount.toLocaleString()}</div>
              <div className="kpi-footnote">今日已有上班刷卡</div>
            </div>
          ) : null}
          {showDepartmentStaySummary ? (
            <div className="kpi-card">
              <div className="kpi-label">平均停留時數</div>
              <div className="kpi-value">{isLoading ? '-' : formatHours(hrMetrics.averageStayHours)}</div>
              <div className="kpi-footnote">依出勤日明細估算</div>
            </div>
          ) : null}
          {showAnomalySummary ? (
            <div className="kpi-card">
              <div className="kpi-label">異常天數</div>
              <div className="kpi-value">{isLoading ? '-' : hrMetrics.anomalyDays.toLocaleString()}</div>
              <div className="kpi-footnote">拒絕通行或缺少上下班</div>
            </div>
          ) : null}
        </section>
      ) : null}

      {showDepartmentStayRanking ? (
        <section className="panel-card mb-3">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h2 className="h6 m-0">部門停留時數排名</h2>
            <span className="small text-secondary">依總停留時數排序</span>
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
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="text-secondary text-center py-4">
                      {isLoading ? '載入中...' : '這段期間沒有部門停留時數資料'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {showAverageWorkHours ? (
        <section className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">平均工時</div>
            <div className="kpi-value">{isLoading ? '-' : formatHours(reportData?.workHours.averageHours)}</div>
          </div>
        </section>
      ) : null}

      {showEventMetrics ? (
        <section className="panel-card report-event-metrics-panel mb-3">
          <h2 className="report-static-section-title">刷卡事件指標</h2>
          <div className="report-event-metrics-grid">
            <div>
              <span>事件總數</span>
              <strong>{metrics.total.toLocaleString()}</strong>
            </div>
            <div>
              <span>允許通行</span>
              <strong>{metrics.granted.toLocaleString()}</strong>
            </div>
            <div>
              <span>拒絕通行</span>
              <strong>{metrics.denied.toLocaleString()}</strong>
            </div>
            <div>
              <span>拒絕率</span>
              <strong>{formatDeniedRate(metrics.deniedRate, metrics.denied)}</strong>
            </div>
            <div>
              <span>刷進</span>
              <strong>{metrics.inCount.toLocaleString()}</strong>
            </div>
            <div>
              <span>刷出</span>
              <strong>{metrics.outCount.toLocaleString()}</strong>
            </div>
            <div>
              <span>刷卡平均延遲</span>
              <strong>{metrics.avgLatencyMs === null ? '-' : `${metrics.avgLatencyMs.toLocaleString()} ms`}</strong>
            </div>
            <div>
              <span>頁面資料產製耗時</span>
              <strong>{reportData?.generationLatencyMs == null ? '-' : `${reportData.generationLatencyMs.toFixed(1)} ms`}</strong>
            </div>
          </div>
        </section>
      ) : null}

      {showWorkTrend ? (
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

      {!isEmployee && showDepartmentDistribution ? (
        <section className="panel-grid mb-3">
          <div className="panel-card">
          <div className="report-section-toolbar">
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
        </section>
      ) : null}

      {showHourlyActivity ? (
        <section className="panel-card report-event-metrics-panel mb-3">
          <div className="report-section-toolbar">
            <h2 className="report-static-section-title">時段活動量</h2>
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
      ) : null}

      {showEventDetails ? (
        <section className="panel-card mb-3">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h2 className="h6 m-0">事件明細</h2>
            <span className="small text-secondary">最近 500 筆</span>
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
                      {isLoading ? '載入中...' : '這段期間沒有事件資料'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {showAttendanceDetails ? (
        <section className="panel-card">
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
    </AppShell>
  )
}

export default Reports
