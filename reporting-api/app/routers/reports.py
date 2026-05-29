from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_optional_current_user
from app.models import UserAccount
from app.repositories import (
    get_attendance_daily,
    get_access_summary,
    get_compliance_anomalies,
    get_dashboard,
    get_department_analytics,
    get_department_employee_metrics,
    get_department_summary,
    get_department_tree,
    get_employee_states,
    get_report_center,
    get_timeseries,
    list_anomalies,
    parse_optional_datetime,
    query_access_events,
    update_compliance_anomaly_remark,
)

router = APIRouter()


class RemarkUpdateRequest(BaseModel):
    note: str


@router.get("/reports/access/summary")
def access_summary(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    department_id: str | None = Query(default=None, alias="departmentId"),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return get_access_summary(
        db,
        current_user=current_user,
        from_time=parse_optional_datetime(from_),
        to_time=parse_optional_datetime(to),
        department_id=department_id,
    )


@router.get("/reports/dashboard")
def dashboard(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    department_id: str | None = Query(default=None, alias="departmentId"),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return get_dashboard(
        db,
        current_user=current_user,
        from_time=parse_optional_datetime(from_),
        to_time=parse_optional_datetime(to),
        department_id=department_id,
    )


@router.get("/reports/report-center")
def report_center(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    department_id: str | None = Query(default=None, alias="departmentId"),
    limit: int = Query(default=500, ge=1, le=1000),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return get_report_center(
        db,
        current_user=current_user,
        from_time=parse_optional_datetime(from_),
        to_time=parse_optional_datetime(to),
        department_id=department_id,
        limit=limit,
    )


@router.get("/reports/access/events")
def access_events(
    employee_id: str | None = Query(default=None, alias="employeeId"),
    department_id: str | None = Query(default=None, alias="departmentId"),
    decision: str | None = None,
    direction: str | None = None,
    reason: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    result = query_access_events(
        db,
        current_user=current_user,
        employee_id=employee_id,
        department_id=department_id,
        decision=decision,
        direction=direction,
        reason=reason,
        from_time=parse_optional_datetime(from_),
        to_time=parse_optional_datetime(to),
        limit=limit,
        offset=offset,
    )
    return {"events": result["items"], **result}


@router.get("/reports/departments/tree")
def departments_tree(
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return {"departments": get_department_tree(db, current_user=current_user)}


@router.get("/reports/departments/{department_id}/summary")
def department_summary(
    department_id: str,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return get_department_summary(
        db,
        department_id=department_id,
        current_user=current_user,
        from_time=parse_optional_datetime(from_),
        to_time=parse_optional_datetime(to),
    )


@router.get("/reports/departments/analytics")
def department_analytics(
    days: int = Query(default=31, ge=1, le=120),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return get_department_analytics(db, current_user=current_user, days=days)


@router.get("/reports/departments/{department_id}/employees")
def department_employees(
    department_id: str,
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return get_department_employee_metrics(
        db,
        department_id=department_id,
        current_user=current_user,
        limit=limit,
        offset=offset,
    )


@router.get("/reports/employees/current-state")
def employee_current_state(
    department_id: str | None = Query(default=None, alias="departmentId"),
    state: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return get_employee_states(
        db,
        current_user=current_user,
        department_id=department_id,
        state=state,
        limit=limit,
        offset=offset,
    )


@router.get("/reports/anomalies")
def anomalies(
    department_id: str | None = Query(default=None, alias="departmentId"),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return list_anomalies(
        db,
        current_user=current_user,
        from_time=parse_optional_datetime(from_),
        to_time=parse_optional_datetime(to),
        department_id=department_id,
        limit=limit,
        offset=offset,
    )


@router.get("/reports/attendance/daily")
def attendance_daily(
    employee_id: str | None = Query(default=None, alias="employeeId"),
    department_id: str | None = Query(default=None, alias="departmentId"),
    limit: int = Query(default=31, ge=1, le=120),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return get_attendance_daily(
        db,
        current_user=current_user,
        employee_id=employee_id,
        department_id=department_id,
        limit=limit,
    )


@router.get("/reports/compliance/anomalies")
def compliance_anomalies(
    department_id: str | None = Query(default=None, alias="departmentId"),
    anomaly_type: str | None = Query(default=None, alias="type"),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    days: int = Query(default=7, ge=1, le=31),
    limit: int = Query(default=100, ge=1, le=200),
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return get_compliance_anomalies(
        db,
        current_user=current_user,
        department_id=department_id,
        anomaly_type=anomaly_type,
        from_time=parse_optional_datetime(from_),
        to_time=parse_optional_datetime(to),
        days=days,
        limit=limit,
    )


@router.patch("/reports/compliance/anomalies/{anomaly_id}/remark")
def compliance_anomaly_remark(
    anomaly_id: str,
    payload: RemarkUpdateRequest,
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    try:
        return update_compliance_anomaly_remark(
            db,
            anomaly_id=anomaly_id,
            remark=payload.note,
            current_user=current_user,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/reports/timeseries")
def timeseries(
    department_id: str | None = Query(default=None, alias="departmentId"),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    current_user: UserAccount | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return {
        "points": get_timeseries(
            db,
            current_user=current_user,
            from_time=parse_optional_datetime(from_),
            to_time=parse_optional_datetime(to),
            department_id=department_id,
        )
    }
