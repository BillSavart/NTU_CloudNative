import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import Reports from './Reports'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Reports', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hides the TSMC root department from the executive report center selector', async () => {
    const executive = {
      userId: 113,
      username: 'executive',
      role: 'EXECUTIVE',
      isStaff: true,
      employeeId: '100000',
      displayName: 'Executive',
      departmentId: 'TSMC',
      visibleDepartmentIds: null,
      canViewAllDepartments: true,
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)

      if (url.includes('/api/auth/me')) {
        return Promise.resolve(jsonResponse({ user: executive }))
      }
      if (url.includes('/api/reports/departments/tree')) {
        return Promise.resolve(jsonResponse({
          departments: [
            {
              departmentId: 'TSMC',
              name: 'TSMC Demo HQ',
              children: [
                { departmentId: 'fab_1', name: 'Fab 1', children: [] },
                { departmentId: 'fab_2', name: 'Fab 2', children: [] },
              ],
            },
          ],
        }))
      }
      if (url.includes('/api/reports/report-center')) {
        return Promise.resolve(jsonResponse({
          metrics: {
            totalEvents: 0,
            grantedEvents: 0,
            deniedEvents: 0,
            inEvents: 0,
            outEvents: 0,
            avgLatencyMs: null,
            deniedRate: 0,
          },
          topDepartments: [],
          workHours: {
            averageHours: null,
            workDays: 0,
            monthlyTrend: [],
            quarterlyTrend: [],
            yearlyTrend: [],
          },
          hourlyActivity: [],
          attendanceDetails: [],
          attendanceSummary: null,
          attendanceTrend: [],
          events: [],
          previewLimit: 500,
          generationLatencyMs: 1,
          snapshot: null,
        }))
      }
      if (url.includes('/api/reports/access/events')) {
        return Promise.resolve(jsonResponse({ items: [], total: 0, limit: 20, offset: 0 }))
      }

      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(
      <MemoryRouter>
        <Reports />
      </MemoryRouter>,
    )

    const selector = await waitFor(() => {
      const element = container.querySelector<HTMLSelectElement>('#report-department')
      expect(element).not.toBeNull()
      return element as HTMLSelectElement
    })

    await waitFor(() => {
      const values = Array.from(selector.options).map((option) => option.value)
      expect(values).not.toContain('TSMC')
      expect(values).toContain('fab_1')
      expect(values).toContain('fab_2')
    })
    expect(selector.value).toBe('fab_1')
  })
})
