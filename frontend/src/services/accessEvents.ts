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

export async function fetchRecentAccessEvents(limit = 10): Promise<AccessEvent[]> {
  const response = await fetch(`/api/reports/access/events?limit=${encodeURIComponent(String(limit))}&offset=0`, {
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

