import http from 'k6/http'
import { check, group, sleep } from 'k6'

function requiredEnv(name) {
  const value = __ENV[name]
  if (!value) {
    throw new Error(`${name} must be set by the load-test environment`)
  }
  return value
}

const baseUrl = requiredEnv('BASE_URL')
const loginId = __ENV.LOGIN_ID || 'rd_1_manager'
const password = __ENV.LOGIN_PASSWORD || 'demo123'
const thinkTimeSeconds = Number(__ENV.THINK_TIME_SECONDS || '1')
const p95ThresholdMs = Number(__ENV.P95_THRESHOLD_MS || '15000')

export const options = {
  scenarios: {
    reporting_api_browse: {
      executor: 'ramping-vus',
      stages: [
        { duration: __ENV.RAMP_UP || '30s', target: Number(__ENV.VUS || '20') },
        { duration: __ENV.STEADY || '2m', target: Number(__ENV.VUS || '20') },
        { duration: __ENV.RAMP_DOWN || '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: [`p(95)<${p95ThresholdMs}`],
    checks: ['rate>0.95'],
  },
  tags: {
    testid: __ENV.TEST_ID || 'reporting-api-demo',
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

export default function () {
  group('auth', () => {
    const login = http.post(
      `${baseUrl}/api/login/`,
      JSON.stringify({
        employeeId: loginId,
        password,
        rememberMe: true,
      }),
      {
        ...jsonHeaders(),
        tags: { endpoint: 'login' },
      },
    )
    check(login, {
      'login status is 200': (response) => response.status === 200,
      'login returns user': (response) => Boolean(response.json('user.username')),
    })
  })

  group('report center', () => {
    const report = http.get(`${baseUrl}/api/reports/report-center?limit=50`, {
      tags: { endpoint: 'report_center' },
    })
    check(report, {
      'report center status is 200': (response) => response.status === 200,
      'report center has metrics': (response) => Number(response.json('metrics.totalEvents')) >= 0,
    })
  })

  group('department analytics', () => {
    const analytics = http.get(`${baseUrl}/api/reports/departments/analytics?days=7`, {
      tags: { endpoint: 'department_analytics' },
    })
    check(analytics, {
      'department analytics status is 200': (response) => response.status === 200,
      'department analytics has departments': (response) => Array.isArray(response.json('departments')),
    })
  })

  group('compliance alerts', () => {
    const alerts = http.get(`${baseUrl}/api/reports/compliance/anomalies?type=denied_access&limit=50`, {
      tags: { endpoint: 'compliance_alerts' },
    })
    check(alerts, {
      'compliance alerts status is 200': (response) => response.status === 200,
    })
  })

  sleep(thinkTimeSeconds)
}
