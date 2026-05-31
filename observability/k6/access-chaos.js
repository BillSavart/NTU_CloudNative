// Access-API chaos test (test 3 from the remote runner).
//
// Holds a steady, modest swipe rate against access-api while the runner cuts
// Postgres AND all Kafka brokers (Redis stays up). The point is to prove that:
//
//   1. With DB + Kafka down, access-api STILL makes the correct open/close
//      decision purely from Redis (anti-passback state machine), and
//   2. Every swipe is durably buffered into the Redis recovery stream
//      (eventBuffered === true) even though Kafka publish fails
//      (kafkaQueued === false during the outage).
//
// So the checks here DELIBERATELY ignore kafkaQueued and instead assert
// decision === GRANTED and eventBuffered === true. The runner later confirms
// those buffered events were backfilled into Postgres after recovery by
// comparing `buffered_during_test` against the access_events row count.
//
// Each VU owns one employee and alternates IN/OUT, so under a fresh prefix
// every move is valid and must be GRANTED — the decision stays correct
// regardless of the DB/Kafka outage.
import http from 'k6/http'
import { check } from 'k6'
import { Counter } from 'k6/metrics'

function requiredEnv(name) {
  const value = __ENV[name]
  if (!value) {
    throw new Error(`${name} must be set by the load-test environment`)
  }
  return value
}

const accessBaseUrl = requiredEnv('ACCESS_BASE_URL')
const employeePrefix = (__ENV.EMPLOYEE_PREFIX || `K6CHAOS${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '')
const gateCount = Number(__ENV.GATES || '8')

const bufferedDuringTest = new Counter('buffered_during_test')

export const options = {
  scenarios: {
    access_chaos: {
      executor: 'constant-arrival-rate',
      exec: 'accessSwipe',
      rate: Number(__ENV.RATE || '50'),
      timeUnit: __ENV.TIME_UNIT || '1s',
      duration: __ENV.DURATION || '3m',
      preAllocatedVUs: Number(__ENV.PRE_VUS || '50'),
      maxVUs: Number(__ENV.MAX_VUS || '300'),
    },
  },
  // Tolerant thresholds: failures are expected to dip during the outage. We do
  // not want the run aborted — the recovery/backfill is what we are measuring.
  thresholds: {
    http_req_failed: ['rate<1'],
  },
  tags: {
    testid: __ENV.TEST_ID || 'chaos-db-kafka',
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

  const buffered = swipe.status === 200 && swipe.json('eventBuffered') === true
  if (buffered) {
    bufferedDuringTest.add(1)
  }

  check(swipe, {
    // Decision stays available + correct from Redis even with DB/Kafka down.
    'swipe served (200)': (response) => response.status === 200,
    'decision granted from redis': (response) =>
      response.status === 200 && response.json('decision') === 'GRANTED',
    'event buffered to redis recovery stream': (response) =>
      response.status === 200 && response.json('eventBuffered') === true,
  })
}
