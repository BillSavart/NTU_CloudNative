import json
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import bindparam, func, select, text
from sqlalchemy.orm import Session, selectinload

from app.database import SessionLocal
from app.models import AccessEvent, Department, Employee, UserAccount
from app.permissions import get_descendant_department_ids, get_visible_department_ids
from app.serializers import serialize_access_event, serialize_department_tree


REQUIRED_EVENT_FIELDS = {
    "requestId",
    "employeeId",
    "gateId",
    "direction",
    "decision",
    "reason",
    "previousState",
    "currentState",
    "latencyMs",
    "timestamp",
}
TAIPEI = ZoneInfo("Asia/Taipei")


def parse_access_event(raw: bytes) -> dict[str, Any]:
    payload = json.loads(raw.decode("utf-8"))
    missing = REQUIRED_EVENT_FIELDS - payload.keys()
    if missing:
        raise ValueError(f"access event missing fields: {sorted(missing)}")
    return payload


def parse_event_timestamp(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=TAIPEI)
    return parsed.astimezone(TAIPEI)


def parse_optional_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    return parse_event_timestamp(value)


def save_access_event(payload: dict[str, Any]) -> bool:
    with SessionLocal() as db:
        return save_access_event_with_session(db, payload)


def save_access_event_with_session(db: Session, payload: dict[str, Any]) -> bool:
    request_id = str(payload["requestId"])
    existing = db.scalar(select(AccessEvent.id).where(AccessEvent.request_id == request_id))
    if existing is not None:
        return False

    employee_id = str(payload["employeeId"])
    occurred_at = parse_event_timestamp(str(payload["timestamp"]))
    current_state = str(payload["currentState"])

    employee = db.get(Employee, employee_id)
    if employee is None:
        # Ensure a default department exists so every employee has a department_id
        default_dept_id = "UNASSIGNED"
        dept = db.get(Department, default_dept_id)
        if dept is None:
            dept = Department(department_id=default_dept_id, name="Unassigned")
            db.add(dept)
            db.flush()

        employee = Employee(employee_id=employee_id, department_id=default_dept_id)
        db.add(employee)

    employee.last_known_state = current_state
    employee.last_seen_at = occurred_at

    event = AccessEvent(
        request_id=request_id,
        employee_id=employee_id,
        gate_id=str(payload["gateId"]),
        direction=str(payload["direction"]),
        decision=str(payload["decision"]),
        reason=str(payload["reason"]),
        previous_state=str(payload["previousState"]),
        current_state=current_state,
        latency_ms=int(payload["latencyMs"]),
        remark=payload.get("remark"),
        occurred_at=occurred_at,
    )
    db.add(event)
    db.commit()
    return True


def list_recent_events(limit: int = 50) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 200))
    with SessionLocal() as db:
        events = db.scalars(
            select(AccessEvent).order_by(AccessEvent.occurred_at.desc()).limit(limit)
        ).all()
        return [serialize_access_event(event) for event in events]


def get_access_summary(
    db: Session,
    current_user: UserAccount | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    department_id: str | None = None,
) -> dict[str, Any]:
    event_query = _scoped_event_select(db, current_user, department_id, from_time, to_time)
    employee_query = _scoped_employee_select(db, current_user, department_id)

    total_events = db.scalar(select(func.count()).select_from(event_query.subquery())) or 0
    granted_events = (
        db.scalar(select(func.count()).select_from(event_query.where(AccessEvent.decision == "GRANTED").subquery()))
        or 0
    )
    denied_events = (
        db.scalar(select(func.count()).select_from(event_query.where(AccessEvent.decision == "DENIED").subquery()))
        or 0
    )
    average_latency = db.scalar(select(func.avg(event_query.subquery().c.latency_ms)))

    employees_inside = (
        db.scalar(select(func.count()).select_from(employee_query.where(Employee.last_known_state == "IN").subquery()))
        or 0
    )
    known_employees = db.scalar(select(func.count()).select_from(employee_query.subquery())) or 0
    employees_outside = max(known_employees - employees_inside, 0)
    last_event_at = db.scalar(select(func.max(event_query.subquery().c.occurred_at)))

    return {
        "totalEvents": total_events,
        "grantedEvents": granted_events,
        "deniedEvents": denied_events,
        "knownEmployees": known_employees,
        "employeesInside": employees_inside,
        "employeesOutside": employees_outside,
        "avgLatencyMs": round(float(average_latency), 2) if average_latency is not None else None,
        "lastUpdatedAt": last_event_at.isoformat() if last_event_at is not None else None,
    }


def get_dashboard(
    db: Session,
    current_user: UserAccount | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    department_id: str | None = None,
) -> dict[str, Any]:
    if from_time is None and to_time is None:
        latest_event_at = db.scalar(
            select(func.max(_scoped_event_select(db, current_user, department_id, None, None).subquery().c.occurred_at))
        )
        if latest_event_at is not None:
            to_time = latest_event_at
            from_time = latest_event_at - timedelta(hours=24)
    if from_time is None:
        from_time = datetime.now(TAIPEI) - timedelta(hours=24)
    if to_time is None:
        to_time = datetime.now(TAIPEI)
    summary = get_access_summary(db, current_user, from_time, to_time, department_id)
    return {
        **summary,
        "anomalies": list_anomalies(db, current_user, from_time, to_time, department_id, limit=10, offset=0)[
            "items"
        ],
        "timeseries": get_timeseries(db, current_user, from_time, to_time, department_id),
    }


def query_access_events(
    db: Session,
    current_user: UserAccount | None = None,
    employee_id: str | None = None,
    department_id: str | None = None,
    decision: str | None = None,
    direction: str | None = None,
    reason: str | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    query = _scoped_event_select(db, current_user, department_id, from_time, to_time)

    if employee_id:
        query = query.where(AccessEvent.employee_id == employee_id)
    if decision:
        query = query.where(AccessEvent.decision == decision)
    if direction:
        query = query.where(AccessEvent.direction == direction)
    if reason:
        query = query.where(AccessEvent.reason == reason)

    events = db.scalars(query.order_by(AccessEvent.occurred_at.desc()).limit(limit).offset(offset)).all()
    return {
        "items": [serialize_access_event(event) for event in events],
        "total": offset + len(events),
        "limit": limit,
        "offset": offset,
    }


def get_department_tree(db: Session, current_user: UserAccount | None = None) -> list[dict[str, Any]]:
    visible_ids = _visible_department_ids(db, current_user, None)
    query = select(Department).order_by(Department.name)
    if visible_ids is not None:
        query = query.where(Department.department_id.in_(visible_ids))
    return serialize_department_tree(list(db.scalars(query).all()))


def get_department_summary(
    db: Session,
    department_id: str,
    current_user: UserAccount | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
) -> dict[str, Any]:
    summary = get_access_summary(db, current_user, from_time, to_time, department_id)
    department = db.get(Department, department_id)
    return {
        "departmentId": department_id,
        "name": department.name if department is not None else department_id,
        **summary,
    }


def get_department_analytics(
    db: Session,
    current_user: UserAccount | None = None,
    days: int = 31,
) -> dict[str, Any]:
    days = max(1, min(days, 120))
    visible_ids = _visible_department_ids(db, current_user, None)
    department_query = select(Department).order_by(Department.name)
    if visible_ids is not None:
        department_query = department_query.where(Department.department_id.in_(visible_ids))
    departments = list(db.scalars(department_query).all())
    tree = serialize_department_tree(departments)

    display_nodes = tree
    if len(tree) == 1 and tree[0]["children"]:
        display_nodes = tree[0]["children"]

    display_department_ids = [node["departmentId"] for node in display_nodes]
    descendant_cache = {
        department_id: {department_id, *get_descendant_department_ids(db, department_id)}
        for department_id in display_department_ids
    }
    if visible_ids is not None:
        visible_set = set(visible_ids)
        descendant_cache = {
            department_id: descendants.intersection(visible_set)
            for department_id, descendants in descendant_cache.items()
        }

    leaf_ids = sorted({leaf_id for descendants in descendant_cache.values() for leaf_id in descendants})
    if not leaf_ids:
        return {
            "departments": [],
            "visibleDepartmentCount": len(departments),
            "days": days,
        }

    since = datetime.now(TAIPEI) - timedelta(days=days)
    employee_sql = text(
        """
        SELECT
            department_id,
            count(*) AS known_employees,
            count(*) FILTER (WHERE last_known_state = 'IN') AS employees_inside
        FROM employees
        WHERE department_id IN :leaf_ids
        GROUP BY department_id
        """
    ).bindparams(bindparam("leaf_ids", expanding=True))
    employee_rows = {
        row["department_id"]: row
        for row in db.execute(employee_sql, {"leaf_ids": leaf_ids}).mappings().all()
    }

    daily_sql = text(
        """
        WITH daily AS (
            SELECT
                e.employee_id,
                emp.department_id,
                e.occurred_at::date AS work_date,
                min(e.occurred_at) FILTER (WHERE e.direction = 'IN') AS first_in,
                max(e.occurred_at) FILTER (WHERE e.direction = 'OUT') AS last_out
            FROM access_events e
            JOIN employees emp ON emp.employee_id = e.employee_id
            WHERE emp.department_id IN :leaf_ids
              AND e.gate_id LIKE '%_A'
              AND e.decision = 'GRANTED'
              AND e.occurred_at >= :since
            GROUP BY e.employee_id, emp.department_id, e.occurred_at::date
        )
        SELECT
            department_id,
            count(*) AS daily_records,
            count(*) FILTER (
                WHERE first_in IS NOT NULL
                  AND last_out IS NOT NULL
                  AND first_in::time <= time '08:30:00'
                  AND extract(epoch FROM (last_out - first_in)) / 3600.0 <= 12
            ) AS normal_records,
            count(*) FILTER (WHERE first_in::time > time '08:30:00') AS late_records,
            count(*) FILTER (
                WHERE first_in IS NOT NULL
                  AND last_out IS NOT NULL
                  AND extract(epoch FROM (last_out - first_in)) / 3600.0 > 12
            ) AS overtime_records
        FROM daily
        GROUP BY department_id
        """
    ).bindparams(bindparam("leaf_ids", expanding=True))
    daily_rows = {
        row["department_id"]: row
        for row in db.execute(daily_sql, {"leaf_ids": leaf_ids, "since": since}).mappings().all()
    }

    rows = []
    for node in display_nodes:
        department_id = node["departmentId"]
        descendants = descendant_cache.get(department_id, set())
        known_employees = sum(int(employee_rows.get(leaf_id, {}).get("known_employees", 0)) for leaf_id in descendants)
        employees_inside = sum(int(employee_rows.get(leaf_id, {}).get("employees_inside", 0)) for leaf_id in descendants)
        daily_records = sum(int(daily_rows.get(leaf_id, {}).get("daily_records", 0)) for leaf_id in descendants)
        normal_records = sum(int(daily_rows.get(leaf_id, {}).get("normal_records", 0)) for leaf_id in descendants)
        late_records = sum(int(daily_rows.get(leaf_id, {}).get("late_records", 0)) for leaf_id in descendants)
        overtime_records = sum(int(daily_rows.get(leaf_id, {}).get("overtime_records", 0)) for leaf_id in descendants)

        rows.append(
            {
                "departmentId": department_id,
                "name": node["name"],
                "knownEmployees": known_employees,
                "employeesInside": employees_inside,
                "dailyRecords": daily_records,
                "normalRecords": normal_records,
                "lateRecords": late_records,
                "overtimeRecords": overtime_records,
            }
        )

    return {
        "departments": rows,
        "visibleDepartmentCount": len(departments),
        "days": days,
    }


def get_employee_states(
    db: Session,
    current_user: UserAccount | None = None,
    department_id: str | None = None,
    state: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    query = _scoped_employee_select(db, current_user, department_id)
    if state:
        query = query.where(Employee.last_known_state == state)

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    employees = db.scalars(query.order_by(Employee.last_seen_at.desc().nullslast()).limit(limit).offset(offset)).all()
    return {
        "items": [
            {
                "employeeId": employee.employee_id,
                "displayName": employee.display_name,
                "departmentId": employee.department_id,
                "managerEmployeeId": employee.manager_employee_id,
                "lastKnownState": employee.last_known_state,
                "lastSeenAt": employee.last_seen_at.isoformat() if employee.last_seen_at else None,
            }
            for employee in employees
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def list_anomalies(
    db: Session,
    current_user: UserAccount | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    department_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    return query_access_events(
        db,
        current_user=current_user,
        department_id=department_id,
        from_time=from_time,
        to_time=to_time,
        decision="DENIED",
        limit=limit,
        offset=offset,
    )


def get_attendance_daily(
    db: Session,
    current_user: UserAccount | None = None,
    employee_id: str | None = None,
    department_id: str | None = None,
    limit: int = 31,
) -> dict[str, Any]:
    limit = max(1, min(limit, 120))
    visible_ids = _visible_department_ids(db, current_user, department_id)
    target_employee_id = employee_id
    if current_user is not None and current_user.employee_id and target_employee_id is None:
        target_employee_id = current_user.employee_id
    if current_user is None and target_employee_id is None:
        return {"items": [], "total": 0, "limit": limit}

    since = datetime.now(TAIPEI) - timedelta(days=7)
    params: dict[str, Any] = {"limit": limit, "since": since}
    filters = ["e.gate_id LIKE '%_A'", "e.decision = 'GRANTED'"]
    filters.append("e.occurred_at >= :since")
    if visible_ids is not None:
        filters.append("emp.department_id IN :visible_ids")
        params["visible_ids"] = visible_ids or ["__none__"]
    if target_employee_id:
        filters.append("e.employee_id = :employee_id")
        params["employee_id"] = target_employee_id

    sql = text(
        f"""
        WITH daily AS (
            SELECT
                e.employee_id,
                emp.display_name,
                emp.department_id,
                e.occurred_at::date AS work_date,
                min(e.occurred_at) FILTER (WHERE e.direction = 'IN') AS first_in,
                max(e.occurred_at) FILTER (WHERE e.direction = 'OUT') AS last_out
            FROM access_events e
            JOIN employees emp ON emp.employee_id = e.employee_id
            WHERE {' AND '.join(filters)}
            GROUP BY e.employee_id, emp.display_name, emp.department_id, e.occurred_at::date
        )
        SELECT
            employee_id,
            display_name,
            department_id,
            work_date,
            first_in,
            last_out,
            CASE
                WHEN first_in IS NOT NULL AND last_out IS NOT NULL
                THEN round((extract(epoch FROM (last_out - first_in)) / 3600.0)::numeric, 2)
                ELSE NULL
            END AS work_hours,
            CASE
                WHEN first_in IS NULL THEN '缺少上班刷卡'
                WHEN last_out IS NULL THEN '缺少下班刷卡'
                WHEN first_in::time > time '08:30:00' THEN '遲到'
                WHEN extract(epoch FROM (last_out - first_in)) / 3600.0 > 12 THEN '超過 12 小時'
                ELSE '正常'
            END AS status
        FROM daily
        ORDER BY work_date DESC, employee_id
        LIMIT :limit
        """
    )
    if visible_ids is not None:
        sql = sql.bindparams(bindparam("visible_ids", expanding=True))
    rows = db.execute(sql, params).mappings().all()
    return {
        "items": [
            {
                "employeeId": row["employee_id"],
                "displayName": row["display_name"],
                "departmentId": row["department_id"],
                "date": row["work_date"].isoformat(),
                "firstIn": row["first_in"].isoformat() if row["first_in"] else None,
                "lastOut": row["last_out"].isoformat() if row["last_out"] else None,
                "workHours": float(row["work_hours"]) if row["work_hours"] is not None else None,
                "status": row["status"],
            }
            for row in rows
        ],
        "total": len(rows),
        "limit": limit,
    }


def get_compliance_anomalies(
    db: Session,
    current_user: UserAccount | None = None,
    department_id: str | None = None,
    anomaly_type: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    limit = max(1, min(limit, 200))
    since = datetime.now(TAIPEI) - timedelta(days=31)
    visible_ids = _visible_department_ids(db, current_user, department_id)
    params: dict[str, Any] = {"limit": limit}
    filters = ["e.gate_id LIKE '%_A'", "e.decision = 'GRANTED'"]
    if visible_ids is not None:
        filters.append("emp.department_id IN :visible_ids")
        params["visible_ids"] = visible_ids or ["__none__"]
    if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
        filters.append("e.employee_id = :employee_id")
        params["employee_id"] = current_user.employee_id

    sql = text(
        f"""
        WITH daily AS (
            SELECT
                e.employee_id,
                emp.display_name,
                emp.department_id,
                e.occurred_at::date AS work_date,
                min(e.occurred_at) FILTER (WHERE e.direction = 'IN') AS first_in,
                max(e.occurred_at) FILTER (WHERE e.direction = 'OUT') AS last_out
            FROM access_events e
            JOIN employees emp ON emp.employee_id = e.employee_id
            WHERE {' AND '.join(filters)}
              AND e.occurred_at >= :since
            GROUP BY e.employee_id, emp.display_name, emp.department_id, e.occurred_at::date
        )
        SELECT
            employee_id,
            display_name,
            department_id,
            work_date,
            first_in,
            last_out,
            (
                SELECT ae.remark
                FROM access_events ae
                WHERE ae.employee_id = daily.employee_id
                  AND ae.gate_id LIKE '%_A'
                  AND ae.decision = 'GRANTED'
                  AND ae.direction = 'OUT'
                  AND ae.occurred_at::date = daily.work_date
                ORDER BY ae.occurred_at DESC, ae.id DESC
                LIMIT 1
            ) AS note,
            round((extract(epoch FROM (last_out - first_in)) / 3600.0)::numeric, 2) AS work_hours
        FROM daily
        WHERE first_in IS NOT NULL
          AND last_out IS NOT NULL
          AND extract(epoch FROM (last_out - first_in)) / 3600.0 > 12
        ORDER BY work_date DESC, work_hours DESC
        LIMIT :limit
        """
    )
    if visible_ids is not None:
        sql = sql.bindparams(bindparam("visible_ids", expanding=True))
    params["since"] = since
    overtime_items = []
    if anomaly_type in {None, "all", "overtime_daily"}:
        overtime_rows = db.execute(sql, params).mappings().all()
        overtime_items = [
            {
                "id": f"overtime:{row['work_date']}:{row['employee_id']}",
                "employeeId": row["employee_id"],
                "displayName": row["display_name"],
                "departmentId": row["department_id"],
                "type": "overtime_daily",
                "typeLabel": "超過 12 小時",
                "hours": f"{float(row['work_hours']):.1f}h",
                "occurredAt": row["last_out"].isoformat() if row["last_out"] else row["work_date"].isoformat(),
                "note": row["note"] or "待主管確認",
            }
            for row in overtime_rows
        ]

    denied_params: dict[str, Any] = {"limit": limit, "since": since}
    denied_filters = ["e.decision = 'DENIED'", "e.occurred_at >= :since"]
    if visible_ids is not None:
        denied_filters.append("emp.department_id IN :visible_ids")
        denied_params["visible_ids"] = visible_ids or ["__none__"]
    if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
        denied_filters.append("e.employee_id = :employee_id")
        denied_params["employee_id"] = current_user.employee_id

    denied_sql = text(
        f"""
        SELECT
            e.request_id,
            e.employee_id,
            emp.display_name,
            emp.department_id,
            e.reason,
            e.remark,
            e.occurred_at
        FROM access_events e
        JOIN employees emp ON emp.employee_id = e.employee_id
        WHERE {' AND '.join(denied_filters)}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT :limit
        """
    )
    if visible_ids is not None:
        denied_sql = denied_sql.bindparams(bindparam("visible_ids", expanding=True))
    denied_items = []
    if anomaly_type in {None, "all", "denied_access"}:
        denied_rows = db.execute(denied_sql, denied_params).mappings().all()
        denied_items = [
            {
                "id": f"denied:{row['request_id']}",
                "employeeId": row["employee_id"],
                "displayName": row["display_name"],
                "departmentId": row["department_id"],
                "type": "denied_access",
                "typeLabel": "拒絕通行事件",
                "hours": "-",
                "occurredAt": row["occurred_at"].isoformat(),
                "note": row["remark"] or row["reason"] or "待主管確認",
            }
            for row in denied_rows
        ]

    items = sorted(
        [*overtime_items, *denied_items],
        key=lambda item: item["occurredAt"],
        reverse=True,
    )[:limit]
    return {
        "items": items,
        "total": len(items),
        "limit": limit,
    }


def update_compliance_anomaly_remark(
    db: Session,
    anomaly_id: str,
    remark: str,
    current_user: UserAccount | None = None,
) -> dict[str, Any]:
    if anomaly_id.startswith("denied:"):
        return update_denied_access_remark(db, anomaly_id, remark, current_user)

    parts = anomaly_id.split(":")
    if len(parts) != 3 or parts[0] != "overtime":
        raise ValueError("unsupported anomaly id")

    work_date = parts[1]
    employee_id = parts[2]
    visible_ids = _visible_department_ids(db, current_user, None)
    params: dict[str, Any] = {
        "employee_id": employee_id,
        "work_date": work_date,
        "remark": remark.strip() or None,
    }
    filters = ["e.employee_id = :employee_id", "e.occurred_at::date = CAST(:work_date AS date)"]

    if visible_ids is not None:
        filters.append("emp.department_id IN :visible_ids")
        params["visible_ids"] = visible_ids or ["__none__"]
    if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
        filters.append("e.employee_id = :current_employee_id")
        params["current_employee_id"] = current_user.employee_id

    sql = text(
        f"""
        WITH target AS (
            SELECT e.id
            FROM access_events e
            JOIN employees emp ON emp.employee_id = e.employee_id
            WHERE {' AND '.join(filters)}
              AND e.gate_id LIKE '%_A'
              AND e.decision = 'GRANTED'
              AND e.direction = 'OUT'
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT 1
        )
        UPDATE access_events e
        SET remark = :remark
        FROM target
        WHERE e.id = target.id
        RETURNING e.request_id, e.employee_id, e.remark
        """
    )
    if visible_ids is not None:
        sql = sql.bindparams(bindparam("visible_ids", expanding=True))
    row = db.execute(sql, params).mappings().first()
    if row is None:
        raise LookupError("anomaly not found")
    db.commit()
    return {
        "id": anomaly_id,
        "employeeId": row["employee_id"],
        "requestId": row["request_id"],
        "note": row["remark"] or "待主管確認",
    }


def update_denied_access_remark(
    db: Session,
    anomaly_id: str,
    remark: str,
    current_user: UserAccount | None = None,
) -> dict[str, Any]:
    request_id = anomaly_id.removeprefix("denied:")
    if not request_id:
        raise ValueError("unsupported anomaly id")

    visible_ids = _visible_department_ids(db, current_user, None)
    params: dict[str, Any] = {
        "request_id": request_id,
        "remark": remark.strip() or None,
    }
    filters = ["e.request_id = :request_id", "e.decision = 'DENIED'"]
    if visible_ids is not None:
        filters.append("emp.department_id IN :visible_ids")
        params["visible_ids"] = visible_ids or ["__none__"]
    if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
        filters.append("e.employee_id = :current_employee_id")
        params["current_employee_id"] = current_user.employee_id

    sql = text(
        f"""
        WITH target AS (
            SELECT e.id
            FROM access_events e
            JOIN employees emp ON emp.employee_id = e.employee_id
            WHERE {' AND '.join(filters)}
            LIMIT 1
        )
        UPDATE access_events e
        SET remark = :remark
        FROM target
        WHERE e.id = target.id
        RETURNING e.request_id, e.employee_id, e.remark, e.reason
        """
    )
    if visible_ids is not None:
        sql = sql.bindparams(bindparam("visible_ids", expanding=True))
    row = db.execute(sql, params).mappings().first()
    if row is None:
        raise LookupError("anomaly not found")
    db.commit()
    return {
        "id": anomaly_id,
        "employeeId": row["employee_id"],
        "requestId": row["request_id"],
        "note": row["remark"] or row["reason"] or "待主管確認",
    }


def get_timeseries(
    db: Session,
    current_user: UserAccount | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    department_id: str | None = None,
) -> list[dict[str, Any]]:
    if from_time is None:
        from_time = datetime.now(TAIPEI) - timedelta(hours=24)
    if to_time is None:
        to_time = datetime.now(TAIPEI)

    scoped = _scoped_event_select(db, current_user, department_id, from_time, to_time).subquery()
    bucket = func.date_trunc("hour", scoped.c.occurred_at).label("bucket")
    rows = db.execute(
        select(
            bucket,
            func.count().label("total"),
            func.count().filter(scoped.c.decision == "GRANTED").label("granted"),
            func.count().filter(scoped.c.decision == "DENIED").label("denied"),
        )
        .select_from(scoped)
        .group_by(bucket)
        .order_by(bucket)
    ).all()
    return [
        {
            "bucket": row.bucket.isoformat(),
            "total": row.total,
            "granted": row.granted,
            "denied": row.denied,
        }
        for row in rows
    ]


def _scoped_event_select(
    db: Session,
    current_user: UserAccount | None,
    department_id: str | None,
    from_time: datetime | None,
    to_time: datetime | None,
):
    query = select(AccessEvent).options(selectinload(AccessEvent.employee))
    visible_ids = _visible_department_ids(db, current_user, department_id)
    if visible_ids is not None:
        query = query.join(Employee, AccessEvent.employee_id == Employee.employee_id)
        query = query.where(Employee.department_id.in_(visible_ids))
    if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
        query = query.where(AccessEvent.employee_id == current_user.employee_id)
    if from_time is not None:
        query = query.where(AccessEvent.occurred_at >= from_time)
    if to_time is not None:
        query = query.where(AccessEvent.occurred_at <= to_time)
    return query


def _scoped_employee_select(db: Session, current_user: UserAccount | None, department_id: str | None):
    query = select(Employee)
    visible_ids = _visible_department_ids(db, current_user, department_id)
    if visible_ids is not None:
        query = query.where(Employee.department_id.in_(visible_ids))
    if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
        query = query.where(Employee.employee_id == current_user.employee_id)
    return query


def _visible_department_ids(db: Session, current_user: UserAccount | None, department_id: str | None) -> list[str] | None:
    requested_ids: set[str] | None = None
    if department_id:
        requested_ids = {department_id, *get_descendant_department_ids(db, department_id)}

    if current_user is None:
        return sorted(requested_ids) if requested_ids is not None else None

    visible_ids = get_visible_department_ids(db, current_user)
    if requested_ids is not None:
        if visible_ids is None:
            return sorted(requested_ids)
        return sorted(requested_ids.intersection(visible_ids))
    return visible_ids
