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

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const response = await fetch('/api/reports/dashboard', {
    method: 'GET',
    credentials: 'same-origin',
  })

  if (!response.ok) {
    throw new Error(`Failed to load dashboard summary (${response.status})`)
  }

  return (await response.json()) as DashboardSummary
}
