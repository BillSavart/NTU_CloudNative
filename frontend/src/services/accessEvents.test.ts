import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchAccessEvents,
  fetchAttendanceDaily,
  fetchComplianceAnomalies,
  fetchDashboardSummary,
  fetchDepartmentAnalytics,
  fetchDepartmentEmployeeMetrics,
  fetchDepartmentSummary,
  fetchDepartmentTree,
  fetchRecentAccessEvents,
  fetchReportCenterData,
  updateComplianceAnomalyRemark,
} from './accessEvents'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function mockFetchOnce(body: unknown, init: ResponseInit = {}) {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('access events service', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loads recent access events from the compatibility events field', async () => {
    const event = { requestId: 'r1', employeeId: '100001', gateId: 'gate_1_A', direction: 'IN' }
    const fetchMock = mockFetchOnce({ events: [event], items: [] })

    await expect(fetchRecentAccessEvents(5)).resolves.toEqual([event])
    expect(fetchMock).toHaveBeenCalledWith('/api/reports/access/events?limit=5&offset=0', {
      method: 'GET',
      credentials: 'same-origin',
    })
  })

  it('normalizes paged access events and omits the ALL department filter', async () => {
    const item = { requestId: 'r2', employeeId: '100002', gateId: 'gate_2_A', direction: 'OUT' }
    const fetchMock = mockFetchOnce({ items: [item], total: '12', limit: '25', offset: '5' })

    const result = await fetchAccessEvents({
      employeeId: '100002',
      departmentId: 'ALL',
      from: '2026-05-01',
      to: '2026-05-31',
      limit: 25,
      offset: 5,
    })

    expect(result).toEqual({ events: [item], items: [item], total: 12, limit: 25, offset: 5 })
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '')
    expect(url).toContain('/api/reports/access/events?')
    expect(url).toContain('employeeId=100002')
    expect(url).toContain('limit=25')
    expect(url).toContain('offset=5')
    expect(url).not.toContain('departmentId=ALL')
  })

  it('throws helpful errors when access event requests fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 503 })))

    await expect(fetchAccessEvents()).rejects.toThrow('Failed to load access events (503)')
    await expect(fetchRecentAccessEvents()).rejects.toThrow('Failed to load access events (503)')
  })

  it('loads dashboard summaries with optional filters', async () => {
    const fetchMock = mockFetchOnce({ totalEvents: 10, deniedEvents: 1 })

    await expect(fetchDashboardSummary({ departmentId: 'RD_1', from: '2026-05-01' })).resolves.toEqual({
      totalEvents: 10,
      deniedEvents: 1,
    })

    const url = String(fetchMock.mock.calls[0]?.[0] ?? '')
    expect(url).toContain('/api/reports/dashboard?')
    expect(url).toContain('departmentId=RD_1')
    expect(url).toContain('from=')
  })

  it('normalizes report center data when optional arrays are missing', async () => {
    mockFetchOnce({
      metrics: {
        totalEvents: '8',
        grantedEvents: '7',
        deniedEvents: '1',
        inEvents: '4',
        outEvents: '4',
        deniedRate: '0.125',
      },
      workHours: { workDays: '3' },
      hourlyActivity: [{ hour: '09', count: '6' }],
      previewLimit: '20',
      generationLatencyMs: '15',
    })

    await expect(fetchReportCenterData({ limit: 20 })).resolves.toMatchObject({
      metrics: {
        totalEvents: 8,
        grantedEvents: 7,
        deniedEvents: 1,
        inEvents: 4,
        outEvents: 4,
        avgLatencyMs: null,
        deniedRate: 0.125,
      },
      topDepartments: [],
      workHours: {
        averageHours: null,
        workDays: 3,
        monthlyTrend: [],
        quarterlyTrend: [],
        yearlyTrend: [],
      },
      hourlyActivity: [{ hour: '09', count: 6, inCount: 6, outCount: 0 }],
      events: [],
      previewLimit: 20,
      generationLatencyMs: 15,
    })
  })

  it('loads department and employee analytics endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ departments: [{ departmentId: 'RD_1', children: [] }] }))
      .mockResolvedValueOnce(jsonResponse({ departmentId: 'RD_1', name: 'RD 1', totalEvents: 3 }))
      .mockResolvedValueOnce(jsonResponse({ departments: [{ departmentId: 'RD_1' }], visibleDepartmentCount: '1' }))
      .mockResolvedValueOnce(jsonResponse({
        departmentId: 'RD_1',
        name: 'RD 1',
        monthStart: '2026-05-01',
        items: [{ employeeId: '110001' }],
        summary: {
          totalEmployees: '2',
          pageEmployees: '1',
          insideCount: '1',
          outsideCount: '1',
          unknownCount: '0',
          totalMonthlyWorkHours: '160',
          totalMonthlyAnomalies: '2',
        },
        total: '2',
        limit: '50',
        offset: '0',
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchDepartmentTree()).resolves.toHaveLength(1)
    await expect(fetchDepartmentSummary('RD_1')).resolves.toMatchObject({ departmentId: 'RD_1', name: 'RD 1' })
    await expect(fetchDepartmentAnalytics(14)).resolves.toEqual({
      departments: [{ departmentId: 'RD_1' }],
      visibleDepartmentCount: 1,
      days: 14,
    })
    await expect(fetchDepartmentEmployeeMetrics('RD_1', 50)).resolves.toMatchObject({
      departmentId: 'RD_1',
      summary: { totalEmployees: 2, totalMonthlyWorkHours: 160 },
      total: 2,
      limit: 50,
    })
  })

  it('loads attendance and compliance data and updates anomaly remarks', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ employeeId: '100001' }], total: '1' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'late-1' }], total: '1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'late-1', note: 'checked' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAttendanceDaily(7, 'RD_1')).resolves.toEqual({
      items: [{ employeeId: '100001' }],
      total: 1,
      limit: 7,
    })
    await expect(fetchComplianceAnomalies(10, 'RD_1', 'late', 30, '2026-05-01', '2026-05-31')).resolves.toEqual({
      items: [{ id: 'late-1' }],
      total: 1,
    })
    await expect(updateComplianceAnomalyRemark('late-1', 'checked')).resolves.toEqual({
      id: 'late-1',
      note: 'checked',
    })

    expect(fetchMock).toHaveBeenLastCalledWith('/api/reports/compliance/anomalies/late-1/remark', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ note: 'checked' }),
    })
  })
})
