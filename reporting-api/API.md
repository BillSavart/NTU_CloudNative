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

Run the fake data script before using these accounts:

```bash
./scripts/fake_data.sh
```

Windows PowerShell:

```powershell
.\scripts\fake_data.ps1
```

If an existing fake-data DB needs the historical executive attendance and denied-access patch:

```bash
./scripts/patch_fake_data.sh
```

Windows PowerShell:

```powershell
.\scripts\patch_fake_data.ps1
```

All seeded accounts use password `demo123`.

```text
executive / demo123
fab_1_manager / demo123
fab_2_manager / demo123
fab_3_manager / demo123
fab_4_manager / demo123
fab_5_manager / demo123
rd_1_manager / demo123
it_1_manager / demo123
pe_1_manager / demo123
ee_1_manager / demo123
employee / demo123
```

Roles:

- `EXECUTIVE`: can view all departments. The default executive account is CC Wei.
- `MANAGER`: can view assigned departments and descendants.
- `EMPLOYEE`: can view only the employee's own records.
- No `admin` account is seeded by the current fake data flow.

Default account details:

| Username | Display name | Role | Employee ID | Scope |
| --- | --- | --- | --- | --- |
| `executive` | CC Wei | `EXECUTIVE` | `100000` | All departments |
| `fab_1_manager` | Bill Wang | `MANAGER` | `100001` | `fab_1` and descendants |
| `fab_2_manager` | Ichigo | `MANAGER` | `100002` | `fab_2` and descendants |
| `fab_3_manager` | Steven Lai | `MANAGER` | `100003` | `fab_3` and descendants |
| `fab_4_manager` | Amy Huang | `MANAGER` | `100004` | `fab_4` and descendants |
| `fab_5_manager` | High Ray | `MANAGER` | `100005` | `fab_5` and descendants |
| `rd_1_manager` | Ethan Chen | `MANAGER` | `110001` | `RD_1` |
| `it_1_manager` | Lily Wang | `MANAGER` | `120001` | `IT_1` |
| `pe_1_manager` | Marcus Lin | `MANAGER` | `130001` | `PE_1` |
| `ee_1_manager` | Nina Huang | `MANAGER` | `140001` | `EE_1` |
| `employee` | YP Hung | `EMPLOYEE` | `199001` | Own records only |

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
  "employeeId": "fab_1_manager",
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
    "username": "fab_1_manager",
    "role": "MANAGER",
    "isStaff": true,
    "employeeId": "100001",
    "displayName": "Bill Wang",
    "departmentId": "fab_1",
    "visibleDepartmentIds": ["EE_1", "IT_1", "PE_1", "RD_1", "fab_1"],
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
    "username": "fab_1_manager",
    "role": "MANAGER",
    "isStaff": true,
    "employeeId": "100001",
    "displayName": "Bill Wang",
    "departmentId": "fab_1",
    "visibleDepartmentIds": ["EE_1", "IT_1", "PE_1", "RD_1", "fab_1"],
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
departmentId=fab_1
limit=50
offset=0
```

When `departmentId` is provided, the result includes that department and its
descendants, then intersects with the logged-in user's visible departments.

### GET /reports/dashboard

Returns summary cards, HR and security indicators, gate traffic highlights,
anomaly rows, and hourly time series points.

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
  "generationLatencyMs": 18.42,
  "hrMetrics": {
    "expectedToday": 4,
    "attendedToday": 3,
    "attendanceRate": 75.0,
    "topLateDepartment": { "key": "FAB_A", "count": 2 },
    "topLateWeekday": { "key": "Mon", "count": 4 },
    "overtimeAlerts": [
      {
        "employeeId": "EMP001",
        "displayName": "Operator A",
        "departmentId": "FAB_A",
        "date": "2026-05-10",
        "workHours": 12.8,
        "occurredAt": "2026-05-10T21:20:00+08:00"
      }
    ],
    "overtimeAlertCount": 1
  },
  "securityMetrics": {
    "antiPassbackViolations": 2,
    "topViolationPeople": [
      {
        "employeeId": "EMP002",
        "displayName": "Operator B",
        "departmentId": "FAB_A",
        "count": 2
      }
    ]
  },
  "anomalies": [],
  "timeseries": []
}
```

### GET /reports/report-center

Returns the formal report-center dataset for the selected period and department:
server-side metrics, department distribution, hourly activity, preview events,
and report generation latency in milliseconds.

Query params:

```text
from=2026-05-10T00:00:00Z
to=2026-05-11T00:00:00Z
departmentId=fab_1
limit=500
```

Response:

```json
{
  "metrics": {
    "totalEvents": 1200,
    "grantedEvents": 1180,
    "deniedEvents": 20,
    "inEvents": 610,
    "outEvents": 590,
    "avgLatencyMs": 8.5,
    "deniedRate": 1.67
  },
  "topDepartments": [{ "departmentId": "FAB_A", "count": 420 }],
  "hourlyActivity": [{ "hour": "08", "count": 300 }],
  "events": [],
  "previewLimit": 500,
  "generationLatencyMs": 24.18
}
```

### GET /reports/access/summary

Returns the same aggregate counters as dashboard, without anomaly and time
series details.

### GET /reports/access/events

Query params:

```text
employeeId=199001
departmentId=fab_1
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
      "requestId": "fake:2026-05-26:199001:in",
      "employeeId": "199001",
      "gateId": "gate_1_A",
      "direction": "IN",
      "decision": "GRANTED",
      "reason": "ACCESS_ALLOWED",
      "previousState": "OUT",
      "currentState": "IN",
      "latencyMs": 8,
      "remark": null,
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
      "departmentId": "fab_1",
      "name": "Fab 1",
      "parentDepartmentId": "TSMC",
      "children": [
        {
          "departmentId": "EE_1",
          "name": "EE Fab 1",
          "parentDepartmentId": "fab_1",
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
departmentId=fab_1
state=UNKNOWN|IN|OUT
limit=100
offset=0
```

Response:

```json
{
  "items": [
    {
      "employeeId": "199001",
      "displayName": "YP Hung",
      "departmentId": "EE_1",
      "managerEmployeeId": "140001",
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
