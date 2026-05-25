from typing import Any

from sqlalchemy.orm import Session

from app.models import AccessEvent, Department, UserAccount
from app.permissions import get_visible_department_ids


def serialize_user(db: Session, user: UserAccount) -> dict[str, Any]:
    visible_department_ids = get_visible_department_ids(db, user)
    employee = user.employee
    return {
        "userId": user.user_id,
        "username": user.username,
        "role": user.role,
        "isStaff": user.role in {"ADMIN", "EXECUTIVE", "MANAGER"},
        "employeeId": user.employee_id,
        "displayName": employee.display_name if employee else None,
        "departmentId": employee.department_id if employee else None,
        "visibleDepartmentIds": visible_department_ids,
        "canViewAllDepartments": visible_department_ids is None,
    }


def serialize_department_tree(departments: list[Department]) -> list[dict[str, Any]]:
    nodes: dict[str, dict[str, Any]] = {
        department.department_id: {
            "departmentId": department.department_id,
            "name": department.name,
            "parentDepartmentId": department.parent_department_id,
            "children": [],
        }
        for department in departments
    }

    roots: list[dict[str, Any]] = []
    for department in departments:
        node = nodes[department.department_id]
        if department.parent_department_id and department.parent_department_id in nodes:
            nodes[department.parent_department_id]["children"].append(node)
        else:
            roots.append(node)
    return roots


def serialize_access_event(event: AccessEvent) -> dict[str, Any]:
    employee = event.employee
    return {
        "requestId": event.request_id,
        "employeeId": event.employee_id,
        "displayName": employee.display_name if employee else None,
        "departmentId": employee.department_id if employee else None,
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
