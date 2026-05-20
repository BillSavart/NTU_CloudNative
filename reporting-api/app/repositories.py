import json
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

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
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


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
    employees_outside = (
        db.scalar(select(func.count()).select_from(employee_query.where(Employee.last_known_state == "OUT").subquery()))
        or 0
    )
    known_employees = db.scalar(select(func.count()).select_from(employee_query.subquery())) or 0
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

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    events = db.scalars(query.order_by(AccessEvent.occurred_at.desc()).limit(limit).offset(offset)).all()
    return {
        "items": [serialize_access_event(event) for event in events],
        "total": total,
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


def get_timeseries(
    db: Session,
    current_user: UserAccount | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    department_id: str | None = None,
) -> list[dict[str, Any]]:
    if from_time is None:
        from_time = datetime.now(UTC) - timedelta(hours=24)
    if to_time is None:
        to_time = datetime.now(UTC)

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
    query = select(AccessEvent).join(Employee, AccessEvent.employee_id == Employee.employee_id)
    visible_ids = _visible_department_ids(db, current_user, department_id)
    if visible_ids is not None:
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
