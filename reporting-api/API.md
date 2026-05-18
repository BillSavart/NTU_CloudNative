# Reporting API Contract

Base URL for local development:

```text
http://127.0.0.1:8000/api
```

The API accepts and returns JSON. Authenticated requests can use either the
`reporting_session` HTTP-only cookie set by login, or:

```text
Authorization: Bearer <token>
```

## Demo Accounts

Run the seed script before using these accounts:

```bash
./scripts/seed-reporting-demo-data.sh
```

```text
admin / demo123
executive / demo123
manager / demo123
employee / demo123
```

Roles:

- `ADMIN`, `EXECUTIVE`: can view all departments.
- `MANAGER`: can view assigned departments and descendants.
- `EMPLOYEE`: can view only the employee's own records.

## Auth

### GET /csrf/

Compatibility endpoint for the existing frontend login flow. It sets a
`csrftoken` cookie and returns the same token in the body.

Response:

```json
{
  "csrfToken": "string"
}
```

### POST /login/

Legacy frontend-compatible login path. The request body field is named
`employeeId`, but it accepts either username or employee id.

Request:

```json
{
  "employeeId": "manager",
  "password": "demo123"
}
```

Response:

```json
{
  "message": "登入成功",
  "token": "string",
  "user": {
    "userId": 3,
    "username": "manager",
    "role": "MANAGER",
    "isStaff": true,
    "employeeId": "MGR001",
    "displayName": "Fab A Manager",
    "departmentId": "FAB_A",
    "visibleDepartmentIds": ["FAB_A", "OPS_A"],
    "canViewAllDepartments": false
  }
}
```

Invalid credentials return `401`.

### POST /auth/login

Same request and response as `POST /login/`.

### GET /auth/me

Returns the current logged-in user.

Response:

```json
{
  "user": {
    "userId": 3,
    "username": "manager",
    "role": "MANAGER",
    "isStaff": true,
    "employeeId": "MGR001",
    "displayName": "Fab A Manager",
    "departmentId": "FAB_A",
    "visibleDepartmentIds": ["FAB_A", "OPS_A"],
    "canViewAllDepartments": false
  }
}
```

Unauthenticated requests return `401`.

### POST /auth/logout

Clears the session cookie.

Response:

```json
{
  "message": "已登出"
}
```

## Reports

Most report endpoints currently allow unauthenticated requests for demo
compatibility. If a valid session or bearer token is supplied, the response is
scoped by the user's role.

Common query params:

```text
from=2026-05-10T00:00:00Z
to=2026-05-11T00:00:00Z
departmentId=FAB_A
limit=50
offset=0
```

When `departmentId` is provided, the result includes that department and its
descendants, then intersects with the logged-in user's visible departments.

### GET /reports/dashboard

Returns summary cards, anomaly rows, and hourly time series points.

Response:

```json
{
  "totalEvents": 10,
  "grantedEvents": 8,
  "deniedEvents": 2,
  "knownEmployees": 4,
  "employeesInside": 2,
  "employeesOutside": 1,
  "avgLatencyMs": 12.5,
  "lastUpdatedAt": "2026-05-10T14:25:54+00:00",
  "anomalies": [],
  "timeseries": []
}
```

### GET /reports/access/summary

Returns the same aggregate counters as dashboard, without anomaly and time
series details.

### GET /reports/access/events

Query params:

```text
employeeId=EMP001
departmentId=FAB_A
decision=GRANTED|DENIED
direction=IN|OUT
reason=OK|ANTI_PASSBACK_VIOLATION|NO_ENTRY_RECORD
from=2026-05-10T00:00:00Z
to=2026-05-11T00:00:00Z
limit=50
offset=0
```

Response:

```json
{
  "events": [
    {
      "requestId": "req-001",
      "employeeId": "EMP001",
      "gateId": "GATE_01",
      "direction": "IN",
      "decision": "GRANTED",
      "reason": "OK",
      "previousState": "OUT",
      "currentState": "IN",
      "latencyMs": 8,
      "timestamp": "2026-05-10T14:25:00+00:00",
      "consumedAt": "2026-05-10T14:25:01+00:00"
    }
  ],
  "items": [],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

`events` and `items` contain the same data; `events` exists for older frontend
compatibility.

### GET /reports/departments/tree

Returns the visible department tree for the current user.

Response:

```json
{
  "departments": [
    {
      "departmentId": "FAB_A",
      "name": "Fab A",
      "parentDepartmentId": "TSMC",
      "children": [
        {
          "departmentId": "OPS_A",
          "name": "Operations A",
          "parentDepartmentId": "FAB_A",
          "children": []
        }
      ]
    }
  ]
}
```

### GET /reports/departments/{departmentId}/summary

Returns summary counters for one department and its descendants.

### GET /reports/employees/current-state

Query params:

```text
departmentId=FAB_A
state=UNKNOWN|IN|OUT
limit=100
offset=0
```

Response:

```json
{
  "items": [
    {
      "employeeId": "EMP001",
      "displayName": "Fab A Operator",
      "departmentId": "OPS_A",
      "managerEmployeeId": "MGR001",
      "lastKnownState": "IN",
      "lastSeenAt": "2026-05-10T14:25:00+00:00"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

### GET /reports/anomalies

Returns denied access events. It supports the same time and department filters
as access events.

### GET /reports/timeseries

Returns hourly buckets for total, granted, and denied events.

Response:

```json
{
  "points": [
    {
      "bucket": "2026-05-10T14:00:00+00:00",
      "total": 100,
      "granted": 95,
      "denied": 5
    }
  ]
}
```
