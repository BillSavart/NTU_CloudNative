import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import AccessEvent, Employee


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
        employee = Employee(employee_id=employee_id)
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


def get_access_summary() -> dict[str, Any]:
    with SessionLocal() as db:
        total_events = db.scalar(select(func.count()).select_from(AccessEvent)) or 0
        granted_events = (
            db.scalar(select(func.count()).select_from(AccessEvent).where(AccessEvent.decision == "GRANTED"))
            or 0
        )
        denied_events = (
            db.scalar(select(func.count()).select_from(AccessEvent).where(AccessEvent.decision == "DENIED"))
            or 0
        )
        employees_inside = (
            db.scalar(select(func.count()).select_from(Employee).where(Employee.last_known_state == "IN"))
            or 0
        )
        employees_outside = (
            db.scalar(select(func.count()).select_from(Employee).where(Employee.last_known_state == "OUT"))
            or 0
        )
        known_employees = db.scalar(select(func.count()).select_from(Employee)) or 0

    return {
        "totalEvents": total_events,
        "grantedEvents": granted_events,
        "deniedEvents": denied_events,
        "knownEmployees": known_employees,
        "employeesInside": employees_inside,
        "employeesOutside": employees_outside,
    }


def serialize_access_event(event: AccessEvent) -> dict[str, Any]:
    return {
        "requestId": event.request_id,
        "employeeId": event.employee_id,
        "gateId": event.gate_id,
        "direction": event.direction,
        "decision": event.decision,
        "reason": event.reason,
        "previousState": event.previous_state,
        "currentState": event.current_state,
        "latencyMs": event.latency_ms,
        "timestamp": event.occurred_at.isoformat(),
        "consumedAt": event.consumed_at.isoformat() if event.consumed_at else None,
    }
