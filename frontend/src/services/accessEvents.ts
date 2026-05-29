export type AccessEvent = {
  requestId: string
  employeeId: string
  displayName?: string | null
  departmentId?: string | null
  gateId: string
  direction: 'IN' | 'OUT'
  decision: 'GRANTED' | 'DENIED'
  reason: string
  previousState: 'UNKNOWN' | 'IN' | 'OUT'
  currentState: 'UNKNOWN' | 'IN' | 'OUT'
  latencyMs: number
  timestamp: string
  consumedAt?: string | null
}

export type DepartmentNode = {
  departmentId: string
  name: string
  parentDepartmentId?: string | null
  children: DepartmentNode[]
}

export type AttendanceDailyItem = {
  employeeId: string
  displayName?: string | null
  departmentId?: string | null
  date: string
  firstIn?: string | null
  lastOut?: string | null
  workHours?: number | null
  status: string
}

export type AttendanceDailyResponse = {
  items: AttendanceDailyItem[]
  total: number
  limit: number
}

export type ComplianceAnomaly = {
  id: string
  employeeId: string
  displayName?: string | null
  departmentId: string
  type: string
  typeLabel: string
  hours: string
  occurredAt: string
  note: string
}

export type DepartmentAnalyticsRow = {
  departmentId: string
  name: string
  knownEmployees: number
  employeesInside: number
  dailyRecords: number
  normalRecords: number
  lateRecords: number
  overtimeRecords: number
}

export type DepartmentAnalyticsResponse = {
  departments: DepartmentAnalyticsRow[]
  visibleDepartmentCount: number
  days: number
}

export type DepartmentEmployeeMetric = {
  employeeId: string
  displayName?: string | null
  departmentId?: string | null
  managerEmployeeId?: string | null
  lastKnownState: 'UNKNOWN' | 'IN' | 'OUT'
  lastSeenAt?: string | null
  monthlyWorkHours: number
  monthlyAttendanceDays: number
  monthlyLateCount: number
  monthlyOvertimeCount: number
  monthlyDeniedCount: number
  monthlyAnomalyCount: number
  averageDailyHours?: number | null
}

export type DepartmentEmployeeMetricsResponse = {
  departmentId: string
  name: string
  monthStart: string
  items: DepartmentEmployeeMetric[]
  summary: {
    totalEmployees: number
    pageEmployees: number
    insideCount: number
    outsideCount: number
    unknownCount: number
    totalMonthlyWorkHours: number
    totalMonthlyAnomalies: number
  }
  total: number
  limit: number
  offset: number
}

export type ReportCenterMetrics = {
  totalEvents: number
  grantedEvents: number
  deniedEvents: number
  inEvents: number
  outEvents: number
  avgLatencyMs: number | null
  deniedRate: number
}

export type WorkHourTrendPoint = {
  label: string
  averageHours: number
  totalHours: number
  workDays: number
}

export type WorkHourSummary = {
  averageHours: number | null
  workDays: number
  monthlyTrend: WorkHourTrendPoint[]
  quarterlyTrend: WorkHourTrendPoint[]
  yearlyTrend: WorkHourTrendPoint[]
}

export type ReportCenterResponse = {
  metrics: ReportCenterMetrics
  topDepartments: Array<{ departmentId: string; count: number }>
  workHours: WorkHourSummary
  hourlyActivity: Array<{ hour: string; count: number }>
  events: AccessEvent[]
  previewLimit: number
  generationLatencyMs: number
}

export type AccessEventsResponse = {
  events: AccessEvent[]
  items: AccessEvent[]
  total: number
  limit: number
  offset: number
}

export type DashboardSummary = {
  totalEvents: number
  grantedEvents: number
  deniedEvents: number
  knownEmployees: number
  employeesInside: number
  employeesOutside: number
  avgLatencyMs: number | null
  lastUpdatedAt?: string | null
  generationLatencyMs?: number | null
  hrMetrics?: {
    expectedToday: number
    attendedToday: number
    attendanceRate: number | null
    topLateDepartment?: { key: string; count: number } | null
    topLateWeekday?: { key: string; count: number } | null
    overtimeAlerts: Array<{
      employeeId: string
      displayName?: string | null
      departmentId?: string | null
      consecutiveDays?: number
      date?: string
      workHours?: number
      occurredAt?: string
    }>
    overtimeAlertCount: number
  }
  securityMetrics?: {
    antiPassbackViolations: number
    topViolationPeople: Array<{
      employeeId: string
      displayName?: string | null
      departmentId?: string | null
      count: number
    }>
  }
  trafficMetrics?: {
    peakGateHour?: { gateId: string; hour: number; count: number } | null
    gateTraffic: Array<{ gateId: string; count: number }>
  }
}

export type AccessEventFilters = {
  employeeId?: string
  departmentId?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

function buildAccessEventsQuery(filters: AccessEventFilters = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(filters.limit ?? 10))
  params.set('offset', String(filters.offset ?? 0))

  if (filters.employeeId) params.set('employeeId', filters.employeeId)
  if (filters.departmentId && filters.departmentId !== 'ALL') params.set('departmentId', filters.departmentId)
  if (filters.from) params.set('from', new Date(`${filters.from}T00:00:00`).toISOString())
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59`).toISOString())

  return params.toString()
}

export async function fetchRecentAccessEvents(limit = 10): Promise<AccessEvent[]> {
  const response = await fetch(`/api/reports/access/events?${buildAccessEventsQuery({ limit, offset: 0 })}`, {
    method: 'GET',
    credentials: 'same-origin',
  })

  if (!response.ok) {
    throw new Error(`Failed to load access events (${response.status})`)
  }

  const result = (await response.json()) as Partial<AccessEventsResponse>
  const events = (result.events ?? result.items) as AccessEvent[] | undefined
  return Array.isArray(events) ? events : []
}

export async function fetchAccessEvents(filters: AccessEventFilters = {}): Promise<AccessEventsResponse> {
  const response = await fetch(`/api/reports/access/events?${buildAccessEventsQuery(filters)}`, {
    method: 'GET',
    credentials: 'same-origin',
  })

  if (!response.ok) {
    throw new Error(`Failed to load access events (${response.status})`)
  }

  const result = (await response.json()) as AccessEventsResponse
  return {
    events: Array.isArray(result.events) ? result.events : Array.isArray(result.items) ? result.items : [],
    items: Array.isArray(result.items) ? result.items : Array.isArray(result.events) ? result.events : [],
    total: Number(result.total ?? 0),
    limit: Number(result.limit ?? filters.limit ?? 0),
    offset: Number(result.offset ?? filters.offset ?? 0),
  }
}

export async function fetchDashboardSummary(filters: Pick<AccessEventFilters, 'departmentId' | 'from' | 'to'> = {}): Promise<DashboardSummary> {
  const params = new URLSearchParams()
  if (filters.departmentId && filters.departmentId !== 'ALL') params.set('departmentId', filters.departmentId)
  if (filters.from) params.set('from', new Date(`${filters.from}T00:00:00`).toISOString())
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59`).toISOString())
  const query = params.toString()
  const response = await fetch(`/api/reports/dashboard${query ? `?${query}` : ''}`, {
    method: 'GET',
    credentials: 'same-origin',
  })

  if (!response.ok) {
    throw new Error(`Failed to load dashboard summary (${response.status})`)
  }

  return (await response.json()) as DashboardSummary
}

export async function fetchReportCenterData(filters: AccessEventFilters = {}): Promise<ReportCenterResponse> {
  const response = await fetch(`/api/reports/report-center?${buildAccessEventsQuery(filters)}`, {
    method: 'GET',
    credentials: 'same-origin',
  })

  if (!response.ok) {
    throw new Error(`Failed to load report center (${response.status})`)
  }

  const result = (await response.json()) as Partial<ReportCenterResponse>
  const workHours = result.workHours
  return {
    metrics: {
      totalEvents: Number(result.metrics?.totalEvents ?? 0),
      grantedEvents: Number(result.metrics?.grantedEvents ?? 0),
      deniedEvents: Number(result.metrics?.deniedEvents ?? 0),
      inEvents: Number(result.metrics?.inEvents ?? 0),
      outEvents: Number(result.metrics?.outEvents ?? 0),
      avgLatencyMs: typeof result.metrics?.avgLatencyMs === 'number' ? result.metrics.avgLatencyMs : null,
      deniedRate: Number(result.metrics?.deniedRate ?? 0),
    },
    topDepartments: Array.isArray(result.topDepartments) ? result.topDepartments : [],
    workHours: {
      averageHours: typeof workHours?.averageHours === 'number' ? workHours.averageHours : null,
      workDays: Number(workHours?.workDays ?? 0),
      monthlyTrend: Array.isArray(workHours?.monthlyTrend) ? workHours.monthlyTrend : [],
      quarterlyTrend: Array.isArray(workHours?.quarterlyTrend) ? workHours.quarterlyTrend : [],
      yearlyTrend: Array.isArray(workHours?.yearlyTrend) ? workHours.yearlyTrend : [],
    },
    hourlyActivity: Array.isArray(result.hourlyActivity) ? result.hourlyActivity : [],
    events: Array.isArray(result.events) ? result.events : [],
    previewLimit: Number(result.previewLimit ?? filters.limit ?? 0),
    generationLatencyMs: Number(result.generationLatencyMs ?? 0),
  }
}

export async function fetchDepartmentTree(): Promise<DepartmentNode[]> {
  const response = await fetch('/api/reports/departments/tree', {
    method: 'GET',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(`Failed to load departments (${response.status})`)
  }
  const result = (await response.json()) as { departments?: DepartmentNode[] }
  return Array.isArray(result.departments) ? result.departments : []
}

export async function fetchDepartmentSummary(departmentId: string): Promise<DashboardSummary & { departmentId: string; name: string }> {
  const response = await fetch(`/api/reports/departments/${encodeURIComponent(departmentId)}/summary`, {
    method: 'GET',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(`Failed to load department summary (${response.status})`)
  }
  return (await response.json()) as DashboardSummary & { departmentId: string; name: string }
}

export async function fetchDepartmentAnalytics(days = 31): Promise<DepartmentAnalyticsResponse> {
  const response = await fetch(`/api/reports/departments/analytics?days=${days}`, {
    method: 'GET',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(`Failed to load department analytics (${response.status})`)
  }
  const result = (await response.json()) as Partial<DepartmentAnalyticsResponse>
  return {
    departments: Array.isArray(result.departments) ? result.departments : [],
    visibleDepartmentCount: Number(result.visibleDepartmentCount ?? 0),
    days: Number(result.days ?? days),
  }
}

export async function fetchDepartmentEmployeeMetrics(
  departmentId: string,
  limit = 200,
  offset = 0,
): Promise<DepartmentEmployeeMetricsResponse> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))

  const response = await fetch(
    `/api/reports/departments/${encodeURIComponent(departmentId)}/employees?${params.toString()}`,
    {
      method: 'GET',
      credentials: 'same-origin',
    },
  )
  if (!response.ok) {
    throw new Error(`Failed to load department employees (${response.status})`)
  }
  const result = (await response.json()) as Partial<DepartmentEmployeeMetricsResponse>
  return {
    departmentId: String(result.departmentId ?? departmentId),
    name: String(result.name ?? departmentId),
    monthStart: String(result.monthStart ?? ''),
    items: Array.isArray(result.items) ? result.items : [],
    summary: {
      totalEmployees: Number(result.summary?.totalEmployees ?? 0),
      pageEmployees: Number(result.summary?.pageEmployees ?? 0),
      insideCount: Number(result.summary?.insideCount ?? 0),
      outsideCount: Number(result.summary?.outsideCount ?? 0),
      unknownCount: Number(result.summary?.unknownCount ?? 0),
      totalMonthlyWorkHours: Number(result.summary?.totalMonthlyWorkHours ?? 0),
      totalMonthlyAnomalies: Number(result.summary?.totalMonthlyAnomalies ?? 0),
    },
    total: Number(result.total ?? 0),
    limit: Number(result.limit ?? limit),
    offset: Number(result.offset ?? offset),
  }
}

export async function fetchAttendanceDaily(limit = 31, departmentId?: string): Promise<AttendanceDailyResponse> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (departmentId) params.set('departmentId', departmentId)

  const response = await fetch(`/api/reports/attendance/daily?${params.toString()}`, {
    method: 'GET',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(`Failed to load attendance daily (${response.status})`)
  }
  const result = (await response.json()) as AttendanceDailyResponse
  return {
    items: Array.isArray(result.items) ? result.items : [],
    total: Number(result.total ?? 0),
    limit: Number(result.limit ?? limit),
  }
}

export async function fetchComplianceAnomalies(
  limit = 100,
  departmentId?: string,
  type?: string,
  days = 7,
  from?: string,
  to?: string,
): Promise<{ items: ComplianceAnomaly[]; total: number }> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('days', String(days))
  if (departmentId) params.set('departmentId', departmentId)
  if (type && type !== 'all') params.set('type', type)
  if (from) params.set('from', from)
  if (to) params.set('to', to)

  const response = await fetch(`/api/reports/compliance/anomalies?${params.toString()}`, {
    method: 'GET',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(`Failed to load compliance anomalies (${response.status})`)
  }
  const result = (await response.json()) as { items?: ComplianceAnomaly[]; total?: number }
  return {
    items: Array.isArray(result.items) ? result.items : [],
    total: Number(result.total ?? 0),
  }
}

export async function updateComplianceAnomalyRemark(id: string, note: string): Promise<{ id: string; note: string }> {
  const response = await fetch(`/api/reports/compliance/anomalies/${encodeURIComponent(id)}/remark`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ note }),
  })
  if (!response.ok) {
    throw new Error(`Failed to update anomaly remark (${response.status})`)
  }
  return (await response.json()) as { id: string; note: string }
}
