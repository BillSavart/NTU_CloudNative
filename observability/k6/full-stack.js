import http from 'k6/http'
import { check, group, sleep } from 'k6'

const accessBaseUrl = __ENV.ACCESS_BASE_URL || 'http://access-lb:8080'
const reportingBaseUrl = __ENV.REPORTING_BASE_URL || 'http://reporting-api:8000'
const frontendBaseUrl = __ENV.FRONTEND_BASE_URL || 'http://frontend'
const loginId = __ENV.LOGIN_ID || 'rd_1_manager'
const password = __ENV.LOGIN_PASSWORD || 'demo123'
const thinkTimeSeconds = Number(__ENV.THINK_TIME_SECONDS || '1')
const p95ThresholdMs = Number(__ENV.P95_THRESHOLD_MS || '15000')
const failedRateThreshold = Number(__ENV.FAILED_RATE_THRESHOLD || '0.05')
const checkRateThreshold = Number(__ENV.CHECK_RATE_THRESHOLD || '0.95')
const accessVus = Number(__ENV.ACCESS_VUS || __ENV.VUS || '20')
const reportingVus = Number(__ENV.REPORTING_VUS || Math.max(1, Math.ceil(accessVus / 4)).toString())
const frontendVus = Number(__ENV.FRONTEND_VUS || Math.max(1, Math.ceil(accessVus / 4)).toString())
const employeePrefix = (__ENV.EMPLOYEE_PREFIX || `K6${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '')
const gateCount = Number(__ENV.GATES || '8')

export const options = {
  scenarios: {
    access_swipes: {
      executor: 'ramping-vus',
      exec: 'accessSwipe',
      stages: [
        { duration: __ENV.RAMP_UP || '30s', target: accessVus },
        { duration: __ENV.STEADY || '2m', target: accessVus },
        { duration: __ENV.RAMP_DOWN || '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
    reporting_browse: {
      executor: 'ramping-vus',
      exec: 'reportingBrowse',
      stages: [
        { duration: __ENV.RAMP_UP || '30s', target: reportingVus },
        { duration: __ENV.STEADY || '2m', target: reportingVus },
        { duration: __ENV.RAMP_DOWN || '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
    frontend_proxy_browse: {
      executor: 'ramping-vus',
      exec: 'frontendProxyBrowse',
      stages: [
        { duration: __ENV.RAMP_UP || '30s', target: frontendVus },
        { duration: __ENV.STEADY || '2m', target: frontendVus },
        { duration: __ENV.RAMP_DOWN || '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_failed: [`rate<${failedRateThreshold}`],
    http_req_duration: [`p(95)<${p95ThresholdMs}`],
    checks: [`rate>${checkRateThreshold}`],
  },
  tags: {
    testid: __ENV.TEST_ID || 'full-stack-demo',
    stack: 'ntu-cloudnative',
  },
}

function jsonHeaders() {
  return {
    headers: {
      'Content-Type': 'application/json',
    },
  }
}

function hasJsonPath(response, path) {
  if (response.status !== 200) {
    return false
  }
  return Boolean(response.json(path))
}

function jsonNumberAtLeast(response, path, minimum) {
  if (response.status !== 200) {
    return false
  }
  return Number(response.json(path)) >= minimum
}

function jsonArrayAt(response, path) {
  if (response.status !== 200) {
    return false
  }
  return Array.isArray(response.json(path))
}

function login(baseUrl, endpointTag) {
  const response = http.post(
    `${baseUrl}/api/login/`,
    JSON.stringify({
      employeeId: loginId,
      password,
      rememberMe: true,
    }),
    {
      ...jsonHeaders(),
      tags: { endpoint: endpointTag },
    },
  )

  check(response, {
    [`${endpointTag} status is 200`]: (res) => res.status === 200,
    [`${endpointTag} returns user`]: (res) => hasJsonPath(res, 'user.username'),
  })
}

export function accessSwipe() {
  const employeeId = `${employeePrefix}${String(__VU).padStart(5, '0')}`
  const direction = __ITER % 2 === 0 ? 'IN' : 'OUT'
  const gateId = `gate_${String((__VU % gateCount) + 1).padStart(2, '0')}`

  group('access api swipe', () => {
    const swipe = http.post(
      `${accessBaseUrl}/api/access/swipe`,
      JSON.stringify({ employeeId, gateId, direction }),
      {
        ...jsonHeaders(),
        tags: { endpoint: 'access_swipe' },
      },
    )

    check(swipe, {
      'access swipe status is 200': (response) => response.status === 200,
      'access swipe has request id': (response) => hasJsonPath(response, 'requestId'),
      'access swipe queued kafka': (response) => response.status === 200 && response.json('kafkaQueued') === true,
    })

    if (__ITER % 5 === 0) {
      const state = http.get(`${accessBaseUrl}/api/access/state/${employeeId}`, {
        tags: { endpoint: 'access_state' },
      })
      check(state, {
        'access state status is 200': (response) => response.status === 200,
      })
    }

    if (__ITER % 10 === 0) {
      const recentEvents = http.get(`${accessBaseUrl}/api/access/events?limit=20`, {
        tags: { endpoint: 'access_recent_events' },
      })
      check(recentEvents, {
        'access recent events status is 200': (response) => response.status === 200,
        'access recent events has list': (response) => jsonArrayAt(response, 'events'),
      })
    }
  })

  sleep(thinkTimeSeconds)
}

export function reportingBrowse() {
  group('reporting api browse', () => {
    login(reportingBaseUrl, 'reporting_login')

    const browseGroup = __ITER % 5

    if (browseGroup === 0) {
      const [dashboard, summary] = http.batch([
        ['GET', `${reportingBaseUrl}/api/reports/dashboard`, null, { tags: { endpoint: 'reporting_dashboard' } }],
        ['GET', `${reportingBaseUrl}/api/reports/access/summary`, null, { tags: { endpoint: 'reporting_access_summary' } }],
      ])

      check(dashboard, {
        'reporting dashboard status is 200': (response) => response.status === 200,
        'reporting dashboard has counters': (response) => jsonNumberAtLeast(response, 'totalEvents', 0),
      })

      check(summary, {
        'access summary status is 200': (response) => response.status === 200,
        'access summary has counters': (response) => jsonNumberAtLeast(response, 'totalEvents', 0),
      })
    } else if (browseGroup === 1) {
      const [report, events] = http.batch([
        ['GET', `${reportingBaseUrl}/api/reports/report-center?limit=50`, null, { tags: { endpoint: 'reporting_report_center' } }],
        ['GET', `${reportingBaseUrl}/api/reports/access/events?limit=50`, null, { tags: { endpoint: 'reporting_access_events' } }],
      ])

      check(report, {
        'report center status is 200': (response) => response.status === 200,
        'report center has metrics': (response) => jsonNumberAtLeast(response, 'metrics.totalEvents', 0),
      })

      check(events, {
        'access events status is 200': (response) => response.status === 200,
        'access events has list': (response) => jsonArrayAt(response, 'events'),
      })
    } else if (browseGroup === 2) {
      const [departmentTree, analytics] = http.batch([
        ['GET', `${reportingBaseUrl}/api/reports/departments/tree`, null, { tags: { endpoint: 'reporting_department_tree' } }],
        ['GET', `${reportingBaseUrl}/api/reports/departments/analytics?days=7`, null, { tags: { endpoint: 'reporting_department_analytics' } }],
      ])

      check(departmentTree, {
        'department tree status is 200': (response) => response.status === 200,
        'department tree has departments': (response) => jsonArrayAt(response, 'departments'),
      })

      check(analytics, {
        'department analytics status is 200': (response) => response.status === 200,
        'department analytics has departments': (response) => jsonArrayAt(response, 'departments'),
      })
    } else if (browseGroup === 3) {
      const [states, attendance] = http.batch([
        ['GET', `${reportingBaseUrl}/api/reports/employees/current-state?limit=100`, null, { tags: { endpoint: 'reporting_employee_states' } }],
        ['GET', `${reportingBaseUrl}/api/reports/attendance/daily?limit=31`, null, { tags: { endpoint: 'reporting_attendance_daily' } }],
      ])

      check(states, {
        'employee states status is 200': (response) => response.status === 200,
        'employee states has items': (response) => jsonArrayAt(response, 'items'),
      })

      check(attendance, {
        'attendance daily status is 200': (response) => response.status === 200,
        'attendance daily has items': (response) => jsonArrayAt(response, 'items'),
      })
    } else {
      const alerts = http.get(`${reportingBaseUrl}/api/reports/compliance/anomalies?limit=50`, {
        tags: { endpoint: 'reporting_compliance_alerts' },
      })

      check(alerts, {
        'compliance alerts status is 200': (response) => response.status === 200,
      })
    }
  })

  sleep(thinkTimeSeconds)
}

export function frontendProxyBrowse() {
  group('frontend and proxy browse', () => {
    const shell = http.get(`${frontendBaseUrl}/dashboard`, {
      tags: { endpoint: 'frontend_dashboard_shell' },
    })
    check(shell, {
      'frontend dashboard shell status is 200': (response) => response.status === 200,
      'frontend dashboard shell is html': (response) => String(response.headers['Content-Type'] || '').includes('text/html'),
    })

    login(frontendBaseUrl, 'frontend_proxy_login')

    const proxiedDashboard = http.get(`${frontendBaseUrl}/api/reports/dashboard`, {
      tags: { endpoint: 'frontend_proxy_dashboard' },
    })
    check(proxiedDashboard, {
      'frontend proxy dashboard status is 200': (response) => response.status === 200,
    })

    const proxiedEvents = http.get(`${frontendBaseUrl}/api/reports/access/events?limit=20`, {
      tags: { endpoint: 'frontend_proxy_access_events' },
    })
    check(proxiedEvents, {
      'frontend proxy access events status is 200': (response) => response.status === 200,
    })
  })

  sleep(thinkTimeSeconds)
}
