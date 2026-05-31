// Access-API throughput test (tests 1 & 2 from the remote runner).
//
// Drives ONLY the access-api swipe endpoint through the SSH tunnel so the
// measured QPS is not diluted by reporting/frontend traffic. The executor is
// chosen by K6_EXECUTOR so the same script serves both:
//
//   * constant-arrival-rate  -> hold a fixed RATE (e.g. 500/s for 5m), test 1
//   * ramping-arrival-rate   -> climb a staircase until the system saturates,
//                               test 2 (read the plateau off Grafana / summary)
//
// Each VU owns one employee (EMPLOYEE_PREFIX + __VU) and alternates IN/OUT by
// iteration, so under a fresh prefix every swipe is a valid anti-passback move
// and must come back GRANTED. A fresh prefix per run (set by the runner) keeps
// Redis state clean so the GRANTED check is a real correctness signal.
import http from 'k6/http'
import { check, sleep } from 'k6'

function requiredEnv(name) {
  const value = __ENV[name]
  if (!value) {
    throw new Error(`${name} must be set by the load-test environment`)
  }
  return value
}

const accessBaseUrl = requiredEnv('ACCESS_BASE_URL')
const employeePrefix = (__ENV.EMPLOYEE_PREFIX || `K6${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '')
const gateCount = Number(__ENV.GATES || '8')
const thinkTimeSeconds = Number(__ENV.THINK_TIME_SECONDS || '0')

const executor = __ENV.K6_EXECUTOR || 'constant-arrival-rate'
const timeUnit = __ENV.TIME_UNIT || '1s'
const preAllocatedVUs = Number(__ENV.PRE_VUS || '200')
const maxVUs = Number(__ENV.MAX_VUS || '1500')

// Build the ramping staircase. Explicit "rate:duration,rate:duration,..." via
// STAGES wins; otherwise generate START_RATE -> MAX_RATE in STEP increments,
// each held for STEP_DURATION.
function buildRampingStages() {
  if (__ENV.STAGES) {
    return __ENV.STAGES.split(',').map((part) => {
      const [target, duration] = part.split(':')
      return { target: Number(target), duration }
    })
  }
  const start = Number(__ENV.START_RATE || '100')
  const step = Number(__ENV.STEP || '200')
  const stepDuration = __ENV.STEP_DURATION || '30s'
  const max = Number(__ENV.MAX_RATE || '3000')
  const stages = []
  for (let rate = start; rate <= max; rate += step) {
    stages.push({ target: rate, duration: stepDuration })
  }
  return stages
}

function buildScenario() {
  if (executor === 'ramping-arrival-rate') {
    return {
      access_throughput: {
        executor: 'ramping-arrival-rate',
        exec: 'accessSwipe',
        startRate: Number(__ENV.START_RATE || '100'),
        timeUnit,
        preAllocatedVUs,
        maxVUs,
        stages: buildRampingStages(),
      },
    }
  }
  return {
    access_throughput: {
      executor: 'constant-arrival-rate',
      exec: 'accessSwipe',
      rate: Number(__ENV.RATE || '500'),
      timeUnit,
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs,
      maxVUs,
    },
  }
}

export const options = {
  scenarios: buildScenario(),
  // Loose thresholds: this test is about finding the saturation point, not
  // pass/fail. They never abort the run; watch Grafana / the summary instead.
  thresholds: {
    http_req_failed: ['rate<1'],
  },
  tags: {
    testid: __ENV.TEST_ID || 'access-throughput',
    stack: 'ntu-cloudnative',
  },
}

export function accessSwipe() {
  const employeeId = `${employeePrefix}${String(__VU).padStart(5, '0')}`
  const direction = __ITER % 2 === 0 ? 'IN' : 'OUT'
  const gateId = `gate_${String((__VU % gateCount) + 1).padStart(2, '0')}`

  const swipe = http.post(
    `${accessBaseUrl}/api/access/swipe`,
    JSON.stringify({ employeeId, gateId, direction }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { endpoint: 'access_swipe' },
    },
  )

  check(swipe, {
    'access swipe status is 200': (response) => response.status === 200,
    'access swipe has request id': (response) =>
      response.status === 200 && Boolean(response.json('requestId')),
    'access swipe granted': (response) =>
      response.status === 200 && response.json('decision') === 'GRANTED',
  })

  if (thinkTimeSeconds > 0) {
    sleep(thinkTimeSeconds)
  }
}
