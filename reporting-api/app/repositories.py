import json
import os
import re
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from time import perf_counter
from collections.abc import Iterable
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import bindparam, case, func, or_, select, text
from sqlalchemy.orm import Session, selectinload

from app.config import get_settings
from app.database import SessionLocal
from app.models import AccessEvent, Department, Employee, UserAccount
from app.permissions import get_descendant_department_ids, get_visible_department_ids
from app.serializers import serialize_access_event, serialize_department_tree


def _main_gate_pattern() -> str:
    """SQL LIKE pattern identifying main-entrance gates (configurable)."""
    return get_settings().attendance_main_gate_pattern


def _late_threshold_time() -> time:
    """Daily late-arrival cutoff as a ``time`` (configurable)."""
    return get_settings().attendance_late_threshold_time


# Shift-aware lateness for a 24/7 fab. A single company-wide cutoff cannot work
# when RD/IT run an office day shift while PE/EE rotate around the clock, so
# "late" is judged against the start of the shift an arrival belongs to plus a
# ~15-minute grace. Windows below bucket an arrival time-of-day to its shift:
#   night     19:30 (arrive 17:15-23:00) -> late if > 19:45
#   graveyard 00:00 (arrive 23:00-03:45) -> late if > 00:15 (before midnight = early)
#   day       07:30 (arrive 03:45-08:15) -> late if > 07:45
#   office    09:00 (arrive 08:15-12:00) -> late if > 09:15
#   swing     15:00 (arrive 12:00-17:15) -> late if > 15:15
def _is_late_time(t: time) -> bool:
    """Python form of the shift-aware late rule (used on SQLite paths)."""
    if time(17, 15) <= t < time(23, 0):
        return t > time(19, 45)
    if t >= time(23, 0):
        return False
    if t < time(3, 45):
        return t > time(0, 15)
    if t < time(8, 15):
        return t > time(7, 45)
    if t < time(12, 0):
        return t > time(9, 15)
    return t > time(15, 15)


def _late_sql(col: str) -> str:
    """SQL boolean for the shift-aware late rule on ``col`` (a timestamp).
    Mirrors :func:`_is_late_time`."""
    t = f"({col})::time"
    return (
        "(CASE"
        f" WHEN {t} >= time '17:15' AND {t} < time '23:00' THEN {t} > time '19:45'"
        f" WHEN {t} >= time '23:00' THEN false"
        f" WHEN {t} < time '03:45' THEN {t} > time '00:15'"
        f" WHEN {t} < time '08:15' THEN {t} > time '07:45'"
        f" WHEN {t} < time '12:00' THEN {t} > time '09:15'"
        f" ELSE {t} > time '15:15'"
        " END)"
    )


def _overtime_hours() -> float:
    """Worked-hours threshold above which a day counts as overtime (configurable)."""
    return get_settings().attendance_overtime_hours


def _overtime_label() -> str:
    """Human-readable overtime label reflecting the configured threshold."""
    return f"超過 {_overtime_hours():g} 小時"


@lru_cache(maxsize=8)
def _compile_like(pattern: str) -> "re.Pattern[str]":
    """Translate a SQL LIKE pattern (``%`` = any, ``_`` = single char) to a regex."""
    parts = ["^"]
    for ch in pattern:
        if ch == "%":
            parts.append(".*")
        elif ch == "_":
            parts.append(".")
        else:
            parts.append(re.escape(ch))
    parts.append("$")
    return re.compile("".join(parts))


def _gate_matches_main(gate_id: str | None) -> bool:
    """Python equivalent of ``gate_id LIKE :main_gate_pattern`` for SQLite paths."""
    if gate_id is None:
        return False
    return bool(_compile_like(_main_gate_pattern()).match(gate_id))


def _attendance_rule_params() -> dict[str, Any]:
    """Bind parameters injecting the attendance business rules into raw SQL."""
    return {
        "main_gate_pattern": _main_gate_pattern(),
        "late_threshold": _late_threshold_time().isoformat(),
        "overtime_hours": _overtime_hours(),
    }


WORK_HOUR_SUMMARY_CACHE_TTL_SECONDS = 600
_work_hour_summary_cache: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}

# Short-lived cache for the (expensive, company-wide) default dashboard. The
# executive/all-departments rollup over the full dataset is heavy on a single
# node; caching the default "live" call by scope for a few seconds keeps the
# home overview responsive without changing any query. Set
# DASHBOARD_CACHE_TTL_SECONDS=0 to disable.
DASHBOARD_CACHE_TTL_SECONDS = float(os.getenv("DASHBOARD_CACHE_TTL_SECONDS", "60"))
_dashboard_cache: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}
# Same idea for the report center. The page now defaults to a recent (≈3 month)
# window and only pulls older data on explicit download, so caching windowed
# calls — keyed by scope + window — keeps the live preview responsive across
# reloads within the TTL. Day-granular from/to values mean the default window is
# a stable key that different requests share. The cache is size-bounded so the
# occasional wide download window can't grow it without limit. Shares the
# dashboard TTL.
_report_center_cache: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}
_REPORT_CENTER_CACHE_MAX = 128

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

    event_rows = event_query.subquery()
    event_stats = db.execute(
        select(
            func.count().label("total_events"),
            func.coalesce(
                func.sum(case((event_rows.c.decision == "GRANTED", 1), else_=0)),
                0,
            ).label("granted_events"),
            func.coalesce(
                func.sum(case((event_rows.c.decision == "DENIED", 1), else_=0)),
                0,
            ).label("denied_events"),
            func.avg(event_rows.c.latency_ms).label("average_latency"),
            func.max(event_rows.c.occurred_at).label("last_event_at"),
        ).select_from(event_rows)
    ).one()

    employee_rows = employee_query.subquery()
    employee_stats = db.execute(
        select(
            func.count().label("known_employees"),
            func.coalesce(
                func.sum(case((employee_rows.c.last_known_state == "IN", 1), else_=0)),
                0,
            ).label("employees_inside"),
        ).select_from(employee_rows)
    ).one()

    total_events = int(event_stats.total_events or 0)
    granted_events = int(event_stats.granted_events or 0)
    denied_events = int(event_stats.denied_events or 0)
    average_latency = event_stats.average_latency
    known_employees = int(employee_stats.known_employees or 0)
    employees_inside = int(employee_stats.employees_inside or 0)
    employees_outside = max(known_employees - employees_inside, 0)
    last_event_at = event_stats.last_event_at

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
    started_at = perf_counter()
    # Serve the default "live" dashboard from a short TTL cache, keyed by the
    # caller's visible scope (so executive/all-departments — the slow one — is
    # only computed occasionally). Explicit time windows are never cached.
    use_cache = from_time is None and to_time is None and DASHBOARD_CACHE_TTL_SECONDS > 0
    cache_key = None
    if use_cache:
        visible_ids = _visible_department_ids(db, current_user, department_id)
        scope_key = "ALL" if visible_ids is None else ",".join(visible_ids)
        cache_key = (
            current_user.user_id if current_user is not None else "anonymous",
            department_id or "ALL",
            scope_key,
        )
        cached = _dashboard_cache.get(cache_key)
        if cached is not None and (perf_counter() - cached[0]) < DASHBOARD_CACHE_TTL_SECONDS:
            return cached[1]
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
    operational_metrics = get_dashboard_operational_metrics(
        db,
        current_user=current_user,
        from_time=from_time,
        to_time=to_time,
        department_id=department_id,
    )
    anomalies = list_anomalies(db, current_user, from_time, to_time, department_id, limit=10, offset=0)["items"]
    timeseries = get_timeseries(db, current_user, from_time, to_time, department_id)
    result = {
        **summary,
        **operational_metrics,
        "generationLatencyMs": round((perf_counter() - started_at) * 1000, 2),
        "anomalies": anomalies,
        "timeseries": timeseries,
    }
    if cache_key is not None:
        _dashboard_cache[cache_key] = (perf_counter(), result)
    return result


def _store_report_center_cache(cache_key: tuple[Any, ...], result: dict[str, Any]) -> None:
    """Cache a report-center result, evicting the oldest entry when full.

    Windowed calls (incl. wide download ranges) all land here, so the cache is
    size-bounded: once it exceeds _REPORT_CENTER_CACHE_MAX we drop the entry
    with the oldest timestamp before inserting the new one.
    """
    if len(_report_center_cache) >= _REPORT_CENTER_CACHE_MAX and cache_key not in _report_center_cache:
        oldest_key = min(_report_center_cache, key=lambda key: _report_center_cache[key][0])
        del _report_center_cache[oldest_key]
    _report_center_cache[cache_key] = (perf_counter(), result)


def _compute_report_center_attendance(rows: Iterable[Any]) -> dict[str, Any]:
    """Aggregate per-employee-per-day attendance over a whole window.

    These figures (headcount, average stay hours, anomaly days, the department
    stay ranking and the daily headcount trend) used to be derived on the client
    from the capped event preview, so on a busy site they only reflected the most
    recent ~500 swipes (≈ today). Computing them here over every scoped event in
    the window makes them accurate. The logic mirrors the frontend's
    buildAttendanceDetails / buildHrMetrics / buildDailyAttendanceTrend exactly:
    first_in = earliest GRANTED IN, last_out = latest GRANTED OUT (any gate),
    DENIED events count as anomalies, grouped by Taipei-local date.
    """
    groups: dict[tuple[str, date], dict[str, Any]] = {}
    for row in rows:
        employee_id = row.employee_id
        if not employee_id:
            continue
        day = _local_date(row.occurred_at)
        group = groups.get((employee_id, day))
        if group is None:
            group = {
                "employee_id": employee_id,
                "date": day,
                "department_id": row.department_id or "-",
                "first_in": None,
                "last_out": None,
                "denied": 0,
            }
            groups[(employee_id, day)] = group
        if row.department_id:
            group["department_id"] = row.department_id
        if row.decision == "GRANTED" and row.direction == "IN":
            if group["first_in"] is None or row.occurred_at < group["first_in"]:
                group["first_in"] = row.occurred_at
        elif row.decision == "GRANTED" and row.direction == "OUT":
            if group["last_out"] is None or row.occurred_at > group["last_out"]:
                group["last_out"] = row.occurred_at
        elif row.decision == "DENIED":
            group["denied"] += 1

    total_rows = 0
    attended_rows = 0
    normal_rows = 0
    anomaly_days = 0
    stay_hours: list[float] = []
    attendees: set[str] = set()
    trend: dict[date, set[str]] = defaultdict(set)
    departments: dict[str, dict[str, Any]] = {}

    for group in groups.values():
        total_rows += 1
        first_in = group["first_in"]
        last_out = group["last_out"]
        denied = group["denied"]
        attended = first_in is not None
        normal = first_in is not None and last_out is not None and denied == 0
        anomaly = denied > 0 or first_in is None or last_out is None
        work_hours = None
        if first_in is not None and last_out is not None and last_out > first_in:
            work_hours = (last_out - first_in).total_seconds() / 3600.0

        if attended:
            attended_rows += 1
            attendees.add(group["employee_id"])
            trend[group["date"]].add(group["employee_id"])
        if normal:
            normal_rows += 1
        if anomaly:
            anomaly_days += 1

        dept = departments.setdefault(
            group["department_id"],
            {"total_hours": 0.0, "work_days": 0, "employees": set(), "total_rows": 0, "normal_rows": 0},
        )
        dept["total_rows"] += 1
        if normal:
            dept["normal_rows"] += 1
        if work_hours is not None:
            stay_hours.append(work_hours)
            dept["total_hours"] += work_hours
            dept["work_days"] += 1
            dept["employees"].add(group["employee_id"])

    summary = {
        "periodAttendanceCount": len(attendees),
        "averageStayHours": round(sum(stay_hours) / len(stay_hours), 2) if stay_hours else None,
        "attendanceRate": round(attended_rows / total_rows * 100, 2) if total_rows else None,
        "normalAttendanceRate": round(normal_rows / total_rows * 100, 2) if total_rows else None,
        "anomalyDays": anomaly_days,
        "departmentStayStats": sorted(
            (
                {
                    "departmentId": dept_id,
                    "totalHours": round(stat["total_hours"], 2),
                    "averageHours": round(stat["total_hours"] / stat["work_days"], 2) if stat["work_days"] else None,
                    "workDays": stat["work_days"],
                    "employeeCount": len(stat["employees"]),
                    "normalAttendanceRate": round(stat["normal_rows"] / stat["total_rows"] * 100, 2) if stat["total_rows"] else None,
                }
                for dept_id, stat in departments.items()
            ),
            key=lambda item: item["totalHours"],
            reverse=True,
        ),
    }
    trend_points = [{"label": day.isoformat(), "count": len(employees)} for day, employees in sorted(trend.items())]
    return {"summary": summary, "trend": trend_points}


def _report_center_attendance_for_window(
    db: Session,
    current_user: UserAccount | None,
    from_time: datetime,
    to_time: datetime,
    employee_id: str | None,
    department_id: str | None,
) -> dict[str, Any]:
    rows = _dashboard_event_rows(db, current_user, department_id, from_time, to_time)
    if employee_id:
        rows = [row for row in rows if row.employee_id == employee_id]
    return _compute_report_center_attendance(rows)


def get_report_center(
    db: Session,
    current_user: UserAccount | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    employee_id: str | None = None,
    department_id: str | None = None,
    department_ids: list[str] | None = None,
    limit: int = 500,
) -> dict[str, Any]:
    started_at = perf_counter()
    limit = max(1, min(limit, 1000))
    # Resolve multi-dept: pre-compute effective visible IDs once
    effective_override: list[str] | None = None
    effective_dept_id = department_id
    if department_ids:
        effective_override = _multi_dept_visible_ids(db, current_user, department_ids)
        effective_dept_id = None  # use override instead
    # Cache by scope *and* window so the recent-window live preview (and any
    # repeated download window) stays responsive after the first load. The
    # window is part of the key, so explicit ranges no longer bypass the cache.
    use_cache = DASHBOARD_CACHE_TTL_SECONDS > 0
    cache_key = None
    if use_cache:
        if effective_override is not None:
            scope_key = ",".join(effective_override)
        else:
            visible_ids = _visible_department_ids(db, current_user, effective_dept_id)
            scope_key = "ALL" if visible_ids is None else ",".join(visible_ids)
        cache_key = (
            current_user.user_id if current_user is not None else "anonymous",
            effective_dept_id or "ALL",
            scope_key,
            employee_id or "ALL",
            from_time.isoformat() if from_time is not None else "DEFAULT",
            to_time.isoformat() if to_time is not None else "DEFAULT",
            limit,
        )
        cached = _report_center_cache.get(cache_key)
        if cached is not None and (perf_counter() - cached[0]) < DASHBOARD_CACHE_TTL_SECONDS:
            return cached[1]
    if from_time is None:
        from_time = datetime.now(TAIPEI) - timedelta(days=7)
    if to_time is None:
        to_time = datetime.now(TAIPEI)
    if db.bind is not None and db.bind.dialect.name != "sqlite":
        result = _get_report_center_sql(
            db,
            current_user=current_user,
            from_time=from_time,
            to_time=to_time,
            employee_id=employee_id,
            department_id=effective_dept_id,
            override_visible_ids=effective_override,
            limit=limit,
            started_at=started_at,
        )
        attendance = _report_center_attendance_for_window(
            db, current_user, from_time, to_time, employee_id, department_id
        )
        result["attendanceSummary"] = attendance["summary"]
        result["attendanceTrend"] = attendance["trend"]
        if cache_key is not None:
            _store_report_center_cache(cache_key, result)
        return result

    rows = _dashboard_event_rows(db, current_user, department_id, from_time, to_time)
    if employee_id:
        rows = [row for row in rows if row.employee_id == employee_id]
    total_events = len(rows)
    granted_events = sum(1 for row in rows if row.decision == "GRANTED")
    denied_events = sum(1 for row in rows if row.decision == "DENIED")
    in_count = sum(1 for row in rows if row.direction == "IN")
    out_count = sum(1 for row in rows if row.direction == "OUT")
    latency_values = [row.latency_ms for row in rows if row.latency_ms is not None]
    department_counts: Counter[str] = Counter()
    hourly_counts: Counter[str] = Counter()
    hourly_in_counts: Counter[str] = Counter()
    hourly_out_counts: Counter[str] = Counter()

    for row in rows:
        department_counts[row.department_id or "UNKNOWN"] += 1
        hour = f"{_local_datetime(row.occurred_at).hour:02d}"
        hourly_counts[hour] += 1
        if row.direction == "IN":
            hourly_in_counts[hour] += 1
        if row.direction == "OUT":
            hourly_out_counts[hour] += 1

    excluded_department_ids = _report_center_excluded_department_ids(current_user)
    visible_top_departments = [
        {"departmentId": row_department_id, "count": count}
        for row_department_id, count in department_counts.most_common()
        if row_department_id not in excluded_department_ids
    ]
    if not visible_top_departments and department_counts:
        visible_top_departments = [
            {"departmentId": row_department_id, "count": count}
            for row_department_id, count in department_counts.most_common()
        ]
    top_departments = visible_top_departments[:6]

    preview = query_access_events(
        db,
        current_user=current_user,
        employee_id=employee_id,
        department_id=department_id,
        from_time=from_time,
        to_time=to_time,
        limit=limit,
        offset=0,
    )

    result = {
        "metrics": {
            "totalEvents": total_events,
            "grantedEvents": granted_events,
            "deniedEvents": denied_events,
            "inEvents": in_count,
            "outEvents": out_count,
            "avgLatencyMs": round(sum(latency_values) / len(latency_values), 2) if latency_values else None,
            "deniedRate": round((denied_events / total_events) * 100, 2) if total_events else 0,
        },
        "topDepartments": top_departments,
        "workHours": get_work_hour_summary(db, current_user=current_user, to_time=to_time, department_id=department_id, employee_id=employee_id),
        "hourlyActivity": [
            {
                "hour": hour,
                "count": count,
                "inCount": hourly_in_counts[hour],
                "outCount": hourly_out_counts[hour],
            }
            for hour, count in sorted(hourly_counts.items())
        ],
        "events": preview["items"],
        "previewLimit": limit,
        "generationLatencyMs": round((perf_counter() - started_at) * 1000, 2),
    }
    attendance = _compute_report_center_attendance(rows)
    result["attendanceSummary"] = attendance["summary"]
    result["attendanceTrend"] = attendance["trend"]
    if cache_key is not None:
        _store_report_center_cache(cache_key, result)
    return result


def _get_report_center_sql(
    db: Session,
    current_user: UserAccount | None,
    from_time: datetime,
    to_time: datetime,
    employee_id: str | None,
    department_id: str | None,
    limit: int,
    started_at: float,
    override_visible_ids: list[str] | None = None,
) -> dict[str, Any]:
    scoped_query = _scoped_event_select(db, current_user, department_id, from_time, to_time, override_visible_ids)
    if employee_id:
        scoped_query = scoped_query.where(AccessEvent.employee_id == employee_id)
    scoped = scoped_query.subquery()
    metric_row = db.execute(
        select(
            func.count().label("total_events"),
            func.count().filter(scoped.c.decision == "GRANTED").label("granted_events"),
            func.count().filter(scoped.c.decision == "DENIED").label("denied_events"),
            func.count().filter(scoped.c.direction == "IN").label("in_events"),
            func.count().filter(scoped.c.direction == "OUT").label("out_events"),
            func.avg(scoped.c.latency_ms).label("avg_latency_ms"),
        ).select_from(scoped)
    ).one()

    department_counts = db.execute(
        select(
            Employee.department_id.label("department_id"),
            func.count().label("count"),
        )
        .select_from(scoped)
        .join(Employee, scoped.c.employee_id == Employee.employee_id)
        .group_by(Employee.department_id)
        .order_by(func.count().desc())
    ).mappings().all()
    excluded_department_ids = _report_center_excluded_department_ids(current_user)
    top_departments = [
        {"departmentId": row["department_id"] or "UNKNOWN", "count": int(row["count"])}
        for row in department_counts
        if (row["department_id"] or "UNKNOWN") not in excluded_department_ids
    ]
    if not top_departments and department_counts:
        top_departments = [
            {"departmentId": row["department_id"] or "UNKNOWN", "count": int(row["count"])}
            for row in department_counts
        ]
    top_departments = top_departments[:6]

    hourly_rows = db.execute(
        select(
            func.to_char(func.date_trunc("hour", scoped.c.occurred_at), "HH24").label("hour"),
            func.count().label("count"),
            func.count().filter(scoped.c.direction == "IN").label("in_count"),
            func.count().filter(scoped.c.direction == "OUT").label("out_count"),
        )
        .select_from(scoped)
        .group_by("hour")
        .order_by("hour")
    ).mappings().all()

    preview = query_access_events(
        db,
        current_user=current_user,
        employee_id=employee_id,
        department_id=department_id,
        from_time=from_time,
        to_time=to_time,
        limit=limit,
        offset=0,
    )

    total_events = int(metric_row.total_events or 0)
    denied_events = int(metric_row.denied_events or 0)
    average_latency = metric_row.avg_latency_ms
    return {
        "metrics": {
            "totalEvents": total_events,
            "grantedEvents": int(metric_row.granted_events or 0),
            "deniedEvents": denied_events,
            "inEvents": int(metric_row.in_events or 0),
            "outEvents": int(metric_row.out_events or 0),
            "avgLatencyMs": round(float(average_latency), 2) if average_latency is not None else None,
            "deniedRate": round((denied_events / total_events) * 100, 2) if total_events else 0,
        },
        "topDepartments": top_departments,
        "workHours": get_work_hour_summary(db, current_user=current_user, to_time=to_time, department_id=department_id, employee_id=employee_id),
        "hourlyActivity": [
            {
                "hour": row["hour"],
                "count": int(row["count"]),
                "inCount": int(row["in_count"] or 0),
                "outCount": int(row["out_count"] or 0),
            }
            for row in hourly_rows
        ],
        "events": preview["items"],
        "previewLimit": limit,
        "generationLatencyMs": round((perf_counter() - started_at) * 1000, 2),
    }


def get_work_hour_summary(
    db: Session,
    current_user: UserAccount | None = None,
    to_time: datetime | None = None,
    department_id: str | None = None,
    employee_id: str | None = None,
) -> dict[str, Any]:
    if to_time is None:
        to_time = datetime.now(TAIPEI)
    cache_key = _work_hour_summary_cache_key(db, current_user, to_time, department_id, employee_id)
    cached = _work_hour_summary_cache.get(cache_key)
    now = perf_counter()
    if cached is not None and now - cached[0] < WORK_HOUR_SUMMARY_CACHE_TTL_SECONDS:
        return cached[1]

    if db.bind is not None and db.bind.dialect.name != "sqlite":
        summary = _get_work_hour_summary_sql(db, current_user, to_time, department_id, employee_id)
    else:
        summary = _get_work_hour_summary_in_python(db, current_user, to_time, department_id, employee_id)

    _work_hour_summary_cache[cache_key] = (now, summary)
    if len(_work_hour_summary_cache) > 128:
        oldest_key = min(_work_hour_summary_cache, key=lambda key: _work_hour_summary_cache[key][0])
        _work_hour_summary_cache.pop(oldest_key, None)
    return summary


def _work_hour_summary_cache_key(
    db: Session,
    current_user: UserAccount | None,
    to_time: datetime,
    department_id: str | None,
    employee_id: str | None,
) -> tuple[Any, ...]:
    visible_ids = _visible_department_ids(db, current_user, department_id)
    scope_key = "ALL" if visible_ids is None else ",".join(visible_ids)
    to_date = _local_date(to_time).isoformat()
    user_key = current_user.user_id if current_user is not None else "anonymous"
    return (user_key, department_id or "ALL", employee_id or "ALL_EMPLOYEES", scope_key, to_date)


def _get_work_hour_summary_sql(
    db: Session,
    current_user: UserAccount | None,
    to_time: datetime,
    department_id: str | None,
    employee_id: str | None,
) -> dict[str, Any]:
    history_from = to_time - timedelta(days=370)
    visible_ids = _visible_department_ids(db, current_user, department_id)
    params: dict[str, Any] = {
        "history_from": history_from,
        "to_time": to_time,
        "main_gate_pattern": _main_gate_pattern(),
    }
    filters = [
        "e.gate_id LIKE :main_gate_pattern",
        "e.decision = 'GRANTED'",
        "e.occurred_at >= :history_from",
        "e.occurred_at <= :to_time",
    ]
    employee_ids: list[str] | None = None
    if visible_ids is not None:
        employee_id_query = text(
            """
            SELECT employee_id
            FROM employees
            WHERE department_id IN :visible_ids
            """
        ).bindparams(bindparam("visible_ids", expanding=True))
        employee_ids = list(db.scalars(employee_id_query, {"visible_ids": visible_ids or ["__none__"]}).all())
        filters.append("e.employee_id IN :employee_ids")
        params["employee_ids"] = employee_ids or ["__none__"]
    if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
        filters.append("e.employee_id = :employee_id")
        params["employee_id"] = current_user.employee_id
    elif employee_id:
        filters.append("e.employee_id = :employee_id")
        params["employee_id"] = employee_id

    daily_cte = f"""
        WITH daily AS MATERIALIZED (
            SELECT
                e.employee_id,
                e.occurred_at::date AS work_date,
                min(e.occurred_at) FILTER (WHERE e.direction = 'IN') AS first_in,
                max(e.occurred_at) FILTER (WHERE e.direction = 'OUT') AS last_out
            FROM access_events e
            WHERE {' AND '.join(filters)}
            GROUP BY e.employee_id, e.occurred_at::date
        ),
        completed AS MATERIALIZED (
            SELECT
                work_date,
                extract(epoch FROM (last_out - first_in)) / 3600.0 AS work_hours
            FROM daily
            WHERE first_in IS NOT NULL
              AND last_out IS NOT NULL
              AND last_out > first_in
        )
    """

    query = text(
        f"""
        {daily_cte}
        SELECT
            'summary' AS period,
            NULL::text AS label,
            round(avg(work_hours)::numeric, 2) AS average_hours,
            round(sum(work_hours)::numeric, 2) AS total_hours,
            count(*) AS work_days
        FROM completed
        UNION ALL
        SELECT
            'monthly' AS period,
            to_char(date_trunc('month', work_date), 'YYYY-MM') AS label,
            round(avg(work_hours)::numeric, 2) AS average_hours,
            round(sum(work_hours)::numeric, 2) AS total_hours,
            count(*) AS work_days
        FROM completed
        GROUP BY label
        UNION ALL
        SELECT
            'quarterly' AS period,
            concat(extract(year FROM work_date)::int, ' Q', extract(quarter FROM work_date)::int) AS label,
            round(avg(work_hours)::numeric, 2) AS average_hours,
            round(sum(work_hours)::numeric, 2) AS total_hours,
            count(*) AS work_days
        FROM completed
        GROUP BY label
        UNION ALL
        SELECT
            'yearly' AS period,
            extract(year FROM work_date)::int::text AS label,
            round(avg(work_hours)::numeric, 2) AS average_hours,
            round(sum(work_hours)::numeric, 2) AS total_hours,
            count(*) AS work_days
        FROM completed
        GROUP BY label
        """
    )
    if employee_ids is not None:
        query = query.bindparams(bindparam("employee_ids", expanding=True))
    rows = db.execute(query, params).mappings().all()

    summary = next((row for row in rows if row["period"] == "summary"), {})

    def period_rows(period: str, limit: int) -> list[dict[str, Any]]:
        period_values = sorted(
            [row for row in rows if row["period"] == period and row["label"] is not None],
            key=lambda row: row["label"],
        )[-limit:]
        return [
            {
                "label": row["label"],
                "averageHours": float(row["average_hours"]),
                "totalHours": float(row["total_hours"]),
                "workDays": int(row["work_days"]),
            }
            for row in period_values
        ]

    average_hours = summary.get("average_hours") if summary else None
    return {
        "averageHours": float(average_hours) if average_hours is not None else None,
        "workDays": int(summary.get("work_days", 0) or 0) if summary else 0,
        "monthlyTrend": period_rows("monthly", 12),
        "quarterlyTrend": period_rows("quarterly", 4),
        "yearlyTrend": period_rows("yearly", 3),
    }


def _get_work_hour_summary_in_python(
    db: Session,
    current_user: UserAccount | None,
    to_time: datetime,
    department_id: str | None,
    employee_id: str | None,
) -> dict[str, Any]:
    history_from = to_time - timedelta(days=370)
    rows = _dashboard_event_rows(db, current_user, department_id, history_from, to_time)
    if employee_id and not (current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id):
        rows = [row for row in rows if row.employee_id == employee_id]
    daily: dict[tuple[str, date], dict[str, datetime | None]] = defaultdict(lambda: {"first_in": None, "last_out": None})

    for row in rows:
        if row.decision != "GRANTED" or not _gate_matches_main(row.gate_id):
            continue
        occurred_at = _local_datetime(row.occurred_at)
        key = (row.employee_id, occurred_at.date())
        day = daily[key]
        if row.direction == "IN" and (day["first_in"] is None or occurred_at < day["first_in"]):
            day["first_in"] = occurred_at
        if row.direction == "OUT" and (day["last_out"] is None or occurred_at > day["last_out"]):
            day["last_out"] = occurred_at

    completed_days: list[tuple[date, float]] = []
    for (_, work_date), day in daily.items():
        first_in = day["first_in"]
        last_out = day["last_out"]
        if first_in is None or last_out is None or last_out <= first_in:
            continue
        completed_days.append((work_date, (last_out - first_in).total_seconds() / 3600))

    def summarize_periods(period: str) -> list[dict[str, Any]]:
        buckets: dict[str, list[float]] = defaultdict(list)
        for work_date, hours in completed_days:
            if period == "monthly":
                label = work_date.strftime("%Y-%m")
            elif period == "quarterly":
                quarter = ((work_date.month - 1) // 3) + 1
                label = f"{work_date.year} Q{quarter}"
            else:
                label = str(work_date.year)
            buckets[label].append(hours)

        return [
            {
                "label": label,
                "averageHours": round(sum(values) / len(values), 2),
                "totalHours": round(sum(values), 2),
                "workDays": len(values),
            }
            for label, values in sorted(buckets.items())
        ]

    total_hours = sum(hours for _, hours in completed_days)
    return {
        "averageHours": round(total_hours / len(completed_days), 2) if completed_days else None,
        "workDays": len(completed_days),
        "monthlyTrend": summarize_periods("monthly")[-12:],
        "quarterlyTrend": summarize_periods("quarterly")[-4:],
        "yearlyTrend": summarize_periods("yearly")[-3:],
    }


def get_dashboard_operational_metrics(
    db: Session,
    current_user: UserAccount | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    department_id: str | None = None,
) -> dict[str, Any]:
    if from_time is None:
        from_time = datetime.now(TAIPEI) - timedelta(hours=24)
    if to_time is None:
        to_time = datetime.now(TAIPEI)

    visible_ids = _visible_department_ids(db, current_user, department_id)
    employee_query = _scoped_employee_select(db, current_user, department_id)
    employees = list(db.scalars(employee_query).all())
    employee_departments = {employee.employee_id: employee.department_id for employee in employees}
    employee_names = {employee.employee_id: employee.display_name for employee in employees}
    expected_today = len(employees)

    history_from = min(from_time, to_time - timedelta(days=7))
    history_start_date = _local_date(history_from)
    window_start_date = _local_date(from_time)
    window_end_date = _local_date(to_time)
    events = _dashboard_event_rows(db, current_user, department_id, history_from, to_time)

    # Real-time attendance = how many known employees are currently INSIDE the
    # fab (their last known state) vs. everyone. This is meaningful for 24h
    # shifts, unlike "entered at some point today" which under/over-counts.
    employees_inside = sum(1 for employee in employees if employee.last_known_state == "IN")
    attendance_rate = (employees_inside / expected_today * 100) if expected_today else None

    daily: dict[tuple[str, date], dict[str, datetime | None]] = defaultdict(lambda: {"first_in": None, "last_out": None})
    department_late_counts: Counter[str] = Counter()
    weekday_late_counts: Counter[str] = Counter()
    gate_hour_counts: Counter[tuple[str, int]] = Counter()
    gate_counts: Counter[str] = Counter()
    violation_counts: Counter[str] = Counter()

    for event in events:
        occurred_at = _local_datetime(event.occurred_at)
        window_start = _local_datetime(from_time)
        window_end = _local_datetime(to_time)
        if occurred_at < window_start or occurred_at > window_end:
            continue

        gate_hour_counts[(event.gate_id, occurred_at.hour)] += 1
        gate_counts[event.gate_id] += 1

        if event.decision == "DENIED" and event.reason.startswith("ANTI_PASSBACK"):
            violation_counts[event.employee_id] += 1

    for event in events:
        if event.decision != "GRANTED":
            continue

        occurred_at = _local_datetime(event.occurred_at)
        key = (event.employee_id, occurred_at.date())
        day = daily[key]
        if event.direction == "IN" and (day["first_in"] is None or occurred_at < day["first_in"]):
            day["first_in"] = occurred_at
        if event.direction == "OUT" and (day["last_out"] is None or occurred_at > day["last_out"]):
            day["last_out"] = occurred_at

    daily_overtime_alerts = []
    for (employee_id, work_date), day in daily.items():
        first_in = day["first_in"]
        last_out = day["last_out"]
        if first_in is not None and _is_late_time(first_in.time()) and window_start_date <= work_date <= window_end_date:
            department_late_counts[employee_departments.get(employee_id) or "UNASSIGNED"] += 1
            weekday_late_counts[_weekday_label(work_date)] += 1
        if (
            first_in is not None
            and last_out is not None
            and last_out - first_in > timedelta(hours=12)
            and history_start_date <= work_date <= window_end_date
        ):
            work_hours = round((last_out - first_in).total_seconds() / 3600, 1)
            daily_overtime_alerts.append(
                {
                    "employeeId": employee_id,
                    "displayName": employee_names.get(employee_id),
                    "departmentId": employee_departments.get(employee_id),
                    "date": work_date.isoformat(),
                    "workHours": work_hours,
                    "occurredAt": last_out.isoformat(),
                }
            )
    daily_overtime_alerts.sort(key=lambda item: (item["occurredAt"], item["workHours"]), reverse=True)

    peak_gate = None
    if gate_hour_counts:
        (gate_id, hour), count = gate_hour_counts.most_common(1)[0]
        peak_gate = {"gateId": gate_id, "hour": hour, "count": count}

    top_violation_people = [
        {
            "employeeId": employee_id,
            "displayName": employee_names.get(employee_id),
            "departmentId": employee_departments.get(employee_id),
            "count": count,
        }
        for employee_id, count in violation_counts.most_common(5)
    ]

    return {
        "hrMetrics": {
            "expectedToday": expected_today,
            "attendedToday": employees_inside,
            "attendanceRate": round(attendance_rate, 1) if attendance_rate is not None else None,
            "topLateDepartment": _counter_top_item(department_late_counts),
            "topLateWeekday": _counter_top_item(weekday_late_counts),
            "overtimeAlerts": daily_overtime_alerts[:5],
            "overtimeAlertCount": len(daily_overtime_alerts),
        },
        "securityMetrics": {
            "antiPassbackViolations": sum(violation_counts.values()),
            "topViolationPeople": top_violation_people,
        },
        "trafficMetrics": {
            "peakGateHour": peak_gate,
            "gateTraffic": [
                {"gateId": gate_id, "count": count}
                for gate_id, count in gate_counts.most_common(5)
            ],
        },
    }


def query_access_events(
    db: Session,
    current_user: UserAccount | None = None,
    employee_id: str | None = None,
    department_id: str | None = None,
    department_ids: list[str] | None = None,
    decision: str | None = None,
    direction: str | None = None,
    reason: str | None = None,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    limit: int = 50,
    offset: int = 0,
    q: str | None = None,
) -> dict[str, Any]:
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    # Multi-dept support: use department_ids list when provided
    if department_ids and len(department_ids) > 1:
        effective_ids = _multi_dept_visible_ids(db, current_user, department_ids)
        query = select(AccessEvent).options(selectinload(AccessEvent.employee))
        if effective_ids is not None:
            query = query.join(Employee, AccessEvent.employee_id == Employee.employee_id)
            query = query.where(Employee.department_id.in_(effective_ids))
        if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
            query = query.where(AccessEvent.employee_id == current_user.employee_id)
        if from_time is not None:
            query = query.where(AccessEvent.occurred_at >= from_time)
        if to_time is not None:
            query = query.where(AccessEvent.occurred_at <= to_time)
    else:
        single_dept = (department_ids[0] if department_ids and len(department_ids) == 1 else None) or department_id
        query = _scoped_event_select(db, current_user, single_dept, from_time, to_time)

    if employee_id:
        query = query.where(AccessEvent.employee_id == employee_id)
    if decision:
        query = query.where(AccessEvent.decision == decision)
    if direction:
        query = query.where(AccessEvent.direction == direction)
    if reason:
        query = query.where(AccessEvent.reason == reason)
    if q:
        q_pat = f"%{q}%"
        query = query.where(
            or_(
                AccessEvent.employee_id.ilike(q_pat),
                AccessEvent.employee_id.in_(
                    select(Employee.employee_id).where(Employee.display_name.ilike(q_pat))
                ),
            )
        )

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
            "visibleDepartmentCount": len(display_nodes),
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

    if db.bind is not None and db.bind.dialect.name == "sqlite":
        daily_rows = _department_daily_rows_in_python(db, current_user, leaf_ids, since)
    else:
        daily_sql = text(
            f"""
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
                  AND e.gate_id LIKE :main_gate_pattern
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
                      AND NOT {_late_sql('first_in')}
                ) AS normal_records,
                count(*) FILTER (WHERE first_in IS NOT NULL AND {_late_sql('first_in')}) AS late_records,
                count(*) FILTER (
                    WHERE first_in IS NOT NULL
                      AND last_out IS NOT NULL
                      AND extract(epoch FROM (last_out - first_in)) / 3600.0 > :overtime_hours
                ) AS overtime_records
            FROM daily
            GROUP BY department_id
            """
        ).bindparams(bindparam("leaf_ids", expanding=True))
        daily_rows = {
            row["department_id"]: row
            for row in db.execute(
                daily_sql,
                {"leaf_ids": leaf_ids, "since": since, **_attendance_rule_params()},
            ).mappings().all()
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
        "visibleDepartmentCount": len(rows),
        "days": days,
    }


def _department_daily_rows_in_python(
    db: Session,
    current_user: UserAccount | None,
    leaf_ids: list[str],
    since: datetime,
) -> dict[str, dict[str, int]]:
    now = datetime.now(TAIPEI)
    leaf_set = set(leaf_ids)
    daily: dict[tuple[str, str, date], dict[str, datetime | None]] = defaultdict(lambda: {"first_in": None, "last_out": None})
    for row in _dashboard_event_rows(db, current_user, None, since, now):
        if row.department_id not in leaf_set or row.decision != "GRANTED" or not _gate_matches_main(row.gate_id):
            continue
        occurred_at = _local_datetime(row.occurred_at)
        key = (row.department_id, row.employee_id, occurred_at.date())
        day = daily[key]
        if row.direction == "IN" and (day["first_in"] is None or occurred_at < day["first_in"]):
            day["first_in"] = occurred_at
        if row.direction == "OUT" and (day["last_out"] is None or occurred_at > day["last_out"]):
            day["last_out"] = occurred_at

    rows: dict[str, dict[str, int]] = defaultdict(lambda: {
        "daily_records": 0,
        "normal_records": 0,
        "late_records": 0,
        "overtime_records": 0,
    })
    for key, day in daily.items():
        department_id = key[0]
        first_in = day["first_in"]
        last_out = day["last_out"]
        rows[department_id]["daily_records"] += 1
        if first_in is not None and _is_late_time(first_in.time()):
            rows[department_id]["late_records"] += 1
        if first_in is not None and last_out is not None:
            work_hours = (last_out - first_in).total_seconds() / 3600
            if work_hours > _overtime_hours():
                rows[department_id]["overtime_records"] += 1
            # Overtime still counts as normal attendance as long as the person
            # arrived on time with a complete in/out (overtime is a separate flag).
            if not _is_late_time(first_in.time()):
                rows[department_id]["normal_records"] += 1
    return rows


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


def search_employee_options(
    db: Session,
    current_user: UserAccount | None = None,
    department_id: str | None = None,
    q: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    limit = max(1, min(limit, 200))
    normalized_department_id = None if department_id in (None, "", "ALL") else department_id
    query = _scoped_employee_select(db, current_user, normalized_department_id)

    keyword = (q or "").strip()
    if keyword:
        pattern = f"%{keyword}%"
        query = query.where(
            or_(
                Employee.employee_id.ilike(pattern),
                Employee.display_name.ilike(pattern),
                Employee.department_id.ilike(pattern),
            )
        )

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    employees = db.scalars(
        query.order_by(Employee.department_id.asc().nullslast(), Employee.employee_id.asc()).limit(limit)
    ).all()

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
    }


def get_department_employee_metrics(
    db: Session,
    department_id: str,
    current_user: UserAccount | None = None,
    limit: int = 200,
    offset: int = 0,
) -> dict[str, Any]:
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    now = datetime.now(TAIPEI)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    department = db.get(Department, department_id)
    employee_query = _scoped_employee_select(db, current_user, department_id)
    total = db.scalar(select(func.count()).select_from(employee_query.subquery())) or 0
    employees = list(
        db.scalars(
            employee_query
            .order_by(Employee.department_id, Employee.employee_id)
            .limit(limit)
            .offset(offset)
        ).all()
    )
    employee_ids = [employee.employee_id for employee in employees]
    metrics = _monthly_employee_metrics(db, current_user, department_id, employee_ids, month_start, now)

    inside_count = sum(1 for employee in employees if employee.last_known_state == "IN")
    outside_count = sum(1 for employee in employees if employee.last_known_state == "OUT")
    unknown_count = sum(1 for employee in employees if employee.last_known_state == "UNKNOWN")
    total_work_hours = sum(metrics.get(employee_id, {}).get("monthlyWorkHours", 0.0) for employee_id in employee_ids)
    total_anomalies = sum(metrics.get(employee_id, {}).get("monthlyAnomalyCount", 0) for employee_id in employee_ids)

    return {
        "departmentId": department_id,
        "name": department.name if department is not None else department_id,
        "monthStart": month_start.date().isoformat(),
        "items": [
            {
                "employeeId": employee.employee_id,
                "displayName": employee.display_name,
                "departmentId": employee.department_id,
                "managerEmployeeId": employee.manager_employee_id,
                "lastKnownState": employee.last_known_state,
                "lastSeenAt": employee.last_seen_at.isoformat() if employee.last_seen_at else None,
                **metrics.get(
                    employee.employee_id,
                    {
                        "monthlyWorkHours": 0.0,
                        "monthlyAttendanceDays": 0,
                        "monthlyLateCount": 0,
                        "monthlyOvertimeCount": 0,
                        "monthlyDeniedCount": 0,
                        "monthlyAnomalyCount": 0,
                        "averageDailyHours": None,
                    },
                ),
            }
            for employee in employees
        ],
        "summary": {
            "totalEmployees": total,
            "pageEmployees": len(employees),
            "insideCount": inside_count,
            "outsideCount": outside_count,
            "unknownCount": unknown_count,
            "totalMonthlyWorkHours": round(total_work_hours, 2),
            "totalMonthlyAnomalies": total_anomalies,
        },
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def _monthly_employee_metrics(
    db: Session,
    current_user: UserAccount | None,
    department_id: str,
    employee_ids: list[str],
    month_start: datetime,
    now: datetime,
) -> dict[str, dict[str, Any]]:
    if not employee_ids:
        return {}

    if db.bind is not None and db.bind.dialect.name == "sqlite":
        return _monthly_employee_metrics_in_python(db, current_user, department_id, employee_ids, month_start, now)

    sql = text(
        f"""
        WITH daily AS (
            SELECT
                e.employee_id,
                e.occurred_at::date AS work_date,
                min(e.occurred_at) FILTER (WHERE e.direction = 'IN') AS first_in,
                max(e.occurred_at) FILTER (WHERE e.direction = 'OUT') AS last_out
            FROM access_events e
            WHERE e.employee_id IN :employee_ids
              AND e.gate_id LIKE :main_gate_pattern
              AND e.decision = 'GRANTED'
              AND e.occurred_at >= :month_start
              AND e.occurred_at <= :now
            GROUP BY e.employee_id, e.occurred_at::date
        ),
        daily_rollup AS (
            SELECT
                employee_id,
                count(*) FILTER (WHERE first_in IS NOT NULL) AS attendance_days,
                coalesce(sum(
                    CASE
                        WHEN first_in IS NOT NULL AND last_out IS NOT NULL AND last_out > first_in
                        THEN extract(epoch FROM (last_out - first_in)) / 3600.0
                        ELSE 0
                    END
                ), 0) AS work_hours,
                count(*) FILTER (WHERE first_in IS NOT NULL AND {_late_sql('first_in')}) AS late_count,
                count(*) FILTER (
                    WHERE first_in IS NOT NULL
                      AND last_out IS NOT NULL
                      AND last_out > first_in
                      AND extract(epoch FROM (last_out - first_in)) / 3600.0 > :overtime_hours
                ) AS overtime_count
            FROM daily
            GROUP BY employee_id
        ),
        denied AS (
            SELECT employee_id, count(*) AS denied_count
            FROM access_events
            WHERE employee_id IN :employee_ids
              AND decision = 'DENIED'
              AND occurred_at >= :month_start
              AND occurred_at <= :now
            GROUP BY employee_id
        )
        SELECT
            emp.employee_id,
            coalesce(daily_rollup.attendance_days, 0) AS attendance_days,
            round(coalesce(daily_rollup.work_hours, 0)::numeric, 2) AS work_hours,
            coalesce(daily_rollup.late_count, 0) AS late_count,
            coalesce(daily_rollup.overtime_count, 0) AS overtime_count,
            coalesce(denied.denied_count, 0) AS denied_count
        FROM employees emp
        LEFT JOIN daily_rollup ON daily_rollup.employee_id = emp.employee_id
        LEFT JOIN denied ON denied.employee_id = emp.employee_id
        WHERE emp.employee_id IN :employee_ids
        ORDER BY emp.department_id, emp.employee_id
        """
    ).bindparams(bindparam("employee_ids", expanding=True))
    rows = db.execute(
        sql,
        {"employee_ids": employee_ids, "month_start": month_start, "now": now, **_attendance_rule_params()},
    ).mappings().all()
    return {
        row["employee_id"]: _format_employee_metric_row(
            float(row["work_hours"]),
            int(row["attendance_days"]),
            int(row["late_count"]),
            int(row["overtime_count"]),
            int(row["denied_count"]),
        )
        for row in rows
    }


def _monthly_employee_metrics_in_python(
    db: Session,
    current_user: UserAccount | None,
    department_id: str,
    employee_ids: list[str],
    month_start: datetime,
    now: datetime,
) -> dict[str, dict[str, Any]]:
    employee_id_set = set(employee_ids)
    daily: dict[tuple[str, date], dict[str, datetime | None]] = defaultdict(lambda: {"first_in": None, "last_out": None})
    denied_counts: Counter[str] = Counter()
    for row in _dashboard_event_rows(db, current_user, department_id, month_start, now):
        if row.employee_id not in employee_id_set:
            continue
        if row.decision == "DENIED":
            denied_counts[row.employee_id] += 1
            continue
        if row.decision != "GRANTED" or not _gate_matches_main(row.gate_id):
            continue
        occurred_at = _local_datetime(row.occurred_at)
        key = (row.employee_id, occurred_at.date())
        day = daily[key]
        if row.direction == "IN" and (day["first_in"] is None or occurred_at < day["first_in"]):
            day["first_in"] = occurred_at
        if row.direction == "OUT" and (day["last_out"] is None or occurred_at > day["last_out"]):
            day["last_out"] = occurred_at

    rollup: dict[str, dict[str, float | int]] = defaultdict(lambda: {
        "work_hours": 0.0,
        "attendance_days": 0,
        "late_count": 0,
        "overtime_count": 0,
    })
    for (employee_id, _work_date), day in daily.items():
        first_in = day["first_in"]
        last_out = day["last_out"]
        if first_in is not None:
            rollup[employee_id]["attendance_days"] += 1
            if _is_late_time(first_in.time()):
                rollup[employee_id]["late_count"] += 1
        if first_in is not None and last_out is not None and last_out > first_in:
            work_hours = (last_out - first_in).total_seconds() / 3600
            rollup[employee_id]["work_hours"] += work_hours
            if work_hours > _overtime_hours():
                rollup[employee_id]["overtime_count"] += 1

    return {
        employee_id: _format_employee_metric_row(
            float(rollup[employee_id]["work_hours"]),
            int(rollup[employee_id]["attendance_days"]),
            int(rollup[employee_id]["late_count"]),
            int(rollup[employee_id]["overtime_count"]),
            denied_counts[employee_id],
        )
        for employee_id in employee_ids
    }


def _format_employee_metric_row(
    work_hours: float,
    attendance_days: int,
    late_count: int,
    overtime_count: int,
    denied_count: int,
) -> dict[str, Any]:
    work_hours = max(work_hours, 0.0)
    attendance_days = max(attendance_days, 0)
    anomaly_count = late_count + overtime_count + denied_count
    return {
        "monthlyWorkHours": round(work_hours, 2),
        "monthlyAttendanceDays": attendance_days,
        "monthlyLateCount": late_count,
        "monthlyOvertimeCount": overtime_count,
        "monthlyDeniedCount": denied_count,
        "monthlyAnomalyCount": anomaly_count,
        "averageDailyHours": round(work_hours / attendance_days, 2) if attendance_days else 0.0,
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

    since = datetime.now(TAIPEI) - timedelta(days=limit)
    params: dict[str, Any] = {"limit": limit, "since": since, **_attendance_rule_params()}
    filters = ["e.gate_id LIKE :main_gate_pattern", "e.decision = 'GRANTED'"]
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
                WHEN {_late_sql('first_in')} THEN '遲到'
                WHEN extract(epoch FROM (last_out - first_in)) / 3600.0 > :overtime_hours THEN '{_overtime_label()}'
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
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    days: int = 7,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    days = max(1, min(days, 92))
    now = datetime.now(TAIPEI)
    if to_time is None:
        to_time = now
    if from_time is None:
        from_time = to_time - timedelta(days=days)
    visible_ids = _visible_department_ids(db, current_user, department_id)
    params: dict[str, Any] = {
        **_attendance_rule_params(),
        "limit": limit,
        "offset": offset,
        "from_time": from_time,
        "to_time": to_time,
    }
    filters = ["e.gate_id LIKE :main_gate_pattern", "e.decision = 'GRANTED'"]
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
              AND e.occurred_at >= :from_time
              AND e.occurred_at <= :to_time
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
                  AND ae.gate_id LIKE :main_gate_pattern
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
          AND extract(epoch FROM (last_out - first_in)) / 3600.0 > :overtime_hours
        ORDER BY work_date DESC, work_hours DESC
        LIMIT :limit OFFSET :offset
        """
    )
    if visible_ids is not None:
        sql = sql.bindparams(bindparam("visible_ids", expanding=True))
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
                "typeLabel": _overtime_label(),
                "hours": f"{float(row['work_hours']):.1f}h",
                "occurredAt": row["last_out"].isoformat() if row["last_out"] else row["work_date"].isoformat(),
                "note": row["note"] or "待主管確認",
            }
            for row in overtime_rows
        ]

    late_items = []
    if anomaly_type in {None, "all", "late_arrival"}:
        late_items = _query_late_arrival_items(
            db,
            current_user=current_user,
            department_id=department_id,
            from_time=from_time,
            to_time=to_time,
            limit=limit,
            offset=offset,
        )

    unpaired_sql = text(
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
              AND e.occurred_at >= :from_time
              AND e.occurred_at <= :to_time
            GROUP BY e.employee_id, emp.display_name, emp.department_id, e.occurred_at::date
        )
        SELECT employee_id, display_name, department_id, work_date, first_in, last_out
        FROM daily
        WHERE first_in IS NULL OR last_out IS NULL
        ORDER BY work_date DESC, coalesce(last_out, first_in) DESC
        LIMIT :limit OFFSET :offset
        """
    )
    if visible_ids is not None:
        unpaired_sql = unpaired_sql.bindparams(bindparam("visible_ids", expanding=True))
    unpaired_items = []
    if anomaly_type in {None, "all", "unpaired_access"}:
        unpaired_rows = db.execute(unpaired_sql, params).mappings().all()
        unpaired_items = [
            {
                "id": (
                    f"unpaired:{row['work_date']}:{row['employee_id']}:"
                    f"{'IN' if row['first_in'] is None else 'OUT'}"
                ),
                "employeeId": row["employee_id"],
                "displayName": row["display_name"],
                "departmentId": row["department_id"],
                "type": "unpaired_access",
                "typeLabel": "未配對進出紀錄",
                "hours": "缺 IN" if row["first_in"] is None else "缺 OUT",
                "occurredAt": (row["last_out"] or row["first_in"] or row["work_date"]).isoformat(),
                "note": "缺少進場刷卡" if row["first_in"] is None else "缺少離場刷卡",
            }
            for row in unpaired_rows
        ]

    denied_params: dict[str, Any] = {"limit": limit, "offset": offset, "from_time": from_time, "to_time": to_time}
    denied_filters = ["e.decision = 'DENIED'", "e.occurred_at >= :from_time", "e.occurred_at <= :to_time"]
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
        LIMIT :limit OFFSET :offset
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
        [*overtime_items, *late_items, *unpaired_items, *denied_items],
        key=lambda item: item["occurredAt"],
        reverse=True,
    )[:limit]

    # For single-type queries, run a fast COUNT so the frontend can show the real total.
    total = len(items) + offset  # fallback: at least known count
    if anomaly_type in {"overtime_daily", "late_arrival", "unpaired_access", "denied_access"}:
        count_params: dict[str, Any] = {k: v for k, v in params.items() if k not in ("limit", "offset")}
        if anomaly_type == "denied_access":
            count_params = {k: v for k, v in denied_params.items() if k not in ("limit", "offset")}
            count_sql = text(
                f"""
                SELECT count(*) FROM access_events e
                JOIN employees emp ON emp.employee_id = e.employee_id
                WHERE {' AND '.join(denied_filters)}
                """
            )
            if visible_ids is not None:
                count_sql = count_sql.bindparams(bindparam("visible_ids", expanding=True))
        elif anomaly_type == "overtime_daily":
            count_sql = text(
                f"""
                WITH daily AS (
                    SELECT e.employee_id, e.occurred_at::date AS work_date,
                        min(e.occurred_at) FILTER (WHERE e.direction = 'IN') AS first_in,
                        max(e.occurred_at) FILTER (WHERE e.direction = 'OUT') AS last_out
                    FROM access_events e
                    JOIN employees emp ON emp.employee_id = e.employee_id
                    WHERE {' AND '.join(filters)} AND e.occurred_at >= :from_time AND e.occurred_at <= :to_time
                    GROUP BY e.employee_id, e.occurred_at::date
                )
                SELECT count(*) FROM daily
                WHERE first_in IS NOT NULL AND last_out IS NOT NULL
                  AND extract(epoch FROM (last_out - first_in)) / 3600.0 > :overtime_hours
                """
            )
            if visible_ids is not None:
                count_sql = count_sql.bindparams(bindparam("visible_ids", expanding=True))
        elif anomaly_type == "late_arrival":
            count_sql = text(
                f"""
                WITH ranked AS (
                    SELECT e.employee_id, e.occurred_at,
                        row_number() OVER (PARTITION BY e.employee_id, e.occurred_at::date ORDER BY e.occurred_at ASC) AS rn
                    FROM access_events e
                    JOIN employees emp ON emp.employee_id = e.employee_id
                    WHERE {' AND '.join(filters)} AND e.direction = 'IN'
                      AND e.occurred_at >= :from_time AND e.occurred_at <= :to_time
                )
                SELECT count(*) FROM ranked WHERE rn = 1 AND {_late_sql('occurred_at')}
                """
            )
            if visible_ids is not None:
                count_sql = count_sql.bindparams(bindparam("visible_ids", expanding=True))
        else:  # unpaired_access
            count_sql = text(
                f"""
                WITH daily AS (
                    SELECT e.employee_id, e.occurred_at::date AS work_date,
                        min(e.occurred_at) FILTER (WHERE e.direction = 'IN') AS first_in,
                        max(e.occurred_at) FILTER (WHERE e.direction = 'OUT') AS last_out
                    FROM access_events e
                    JOIN employees emp ON emp.employee_id = e.employee_id
                    WHERE {' AND '.join(filters)} AND e.occurred_at >= :from_time AND e.occurred_at <= :to_time
                    GROUP BY e.employee_id, e.occurred_at::date
                )
                SELECT count(*) FROM daily WHERE first_in IS NULL OR last_out IS NULL
                """
            )
            if visible_ids is not None:
                count_sql = count_sql.bindparams(bindparam("visible_ids", expanding=True))
        try:
            total = int(db.scalar(count_sql, count_params) or 0)
        except Exception:
            total = len(items) + offset

    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
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
    if parts[0] in {"overtime", "late"} and len(parts) == 3:
        anomaly_kind = parts[0]
        work_date = parts[1]
        employee_id = parts[2]
        target_direction = "IN" if anomaly_kind == "late" else "OUT"
        order_direction = "ASC" if anomaly_kind == "late" else "DESC"
    elif parts[0] == "unpaired" and len(parts) == 4 and parts[3] in {"IN", "OUT"}:
        anomaly_kind = parts[0]
        work_date = parts[1]
        employee_id = parts[2]
        missing_direction = parts[3]
        target_direction = "OUT" if missing_direction == "IN" else "IN"
        order_direction = "DESC"
    else:
        raise ValueError("unsupported anomaly id")

    visible_ids = _visible_department_ids(db, current_user, None)
    params: dict[str, Any] = {
        "employee_id": employee_id,
        "work_date": work_date,
        "remark": remark.strip() or None,
        "main_gate_pattern": _main_gate_pattern(),
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
              AND e.gate_id LIKE :main_gate_pattern
              AND e.decision = 'GRANTED'
              AND e.direction = :target_direction
            ORDER BY e.occurred_at {order_direction}, e.id {order_direction}
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
    params["target_direction"] = target_direction
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


def _query_late_arrival_items(
    db: Session,
    current_user: UserAccount | None,
    department_id: str | None,
    from_time: datetime,
    to_time: datetime,
    limit: int,
    offset: int = 0,
) -> list[dict[str, Any]]:
    if db.bind is not None and db.bind.dialect.name == "sqlite":
        return _query_late_arrival_items_in_python(db, current_user, department_id, from_time, to_time, limit)

    visible_ids = _visible_department_ids(db, current_user, department_id)
    params: dict[str, Any] = {
        **_attendance_rule_params(),
        "from_time": from_time,
        "to_time": to_time,
        "limit": limit,
        "offset": offset,
    }
    filters = [
        "e.gate_id LIKE :main_gate_pattern",
        "e.decision = 'GRANTED'",
        "e.direction = 'IN'",
        "e.occurred_at >= :from_time",
        "e.occurred_at <= :to_time",
    ]
    if visible_ids is not None:
        filters.append("emp.department_id IN :visible_ids")
        params["visible_ids"] = visible_ids or ["__none__"]
    if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
        filters.append("e.employee_id = :employee_id")
        params["employee_id"] = current_user.employee_id

    sql = text(
        f"""
        WITH ranked AS (
            SELECT
                e.request_id,
                e.employee_id,
                emp.display_name,
                emp.department_id,
                e.remark,
                e.occurred_at,
                row_number() OVER (
                    PARTITION BY e.employee_id, e.occurred_at::date
                    ORDER BY e.occurred_at ASC, e.id ASC
                ) AS rn
            FROM access_events e
            JOIN employees emp ON emp.employee_id = e.employee_id
            WHERE {' AND '.join(filters)}
        )
        SELECT request_id, employee_id, display_name, department_id, remark, occurred_at
        FROM ranked
        WHERE rn = 1
          AND {_late_sql('occurred_at')}
        ORDER BY occurred_at DESC
        LIMIT :limit OFFSET :offset
        """
    )
    if visible_ids is not None:
        sql = sql.bindparams(bindparam("visible_ids", expanding=True))
    rows = db.execute(sql, params).mappings().all()
    return [
        {
            "id": f"late:{_local_date(row['occurred_at'])}:{row['employee_id']}",
            "employeeId": row["employee_id"],
            "displayName": row["display_name"],
            "departmentId": row["department_id"],
            "type": "late_arrival",
            "typeLabel": "遲到人員",
            "hours": _local_datetime(row["occurred_at"]).strftime("%H:%M"),
            "occurredAt": row["occurred_at"].isoformat(),
            "note": row["remark"] or "待主管確認",
        }
        for row in rows
    ]


def _query_late_arrival_items_in_python(
    db: Session,
    current_user: UserAccount | None,
    department_id: str | None,
    from_time: datetime,
    to_time: datetime,
    limit: int,
) -> list[dict[str, Any]]:
    late_daily: dict[tuple[str, date], Any] = {}
    for row in _dashboard_event_rows(db, current_user, department_id, from_time, to_time):
        if row.decision != "GRANTED" or row.direction != "IN" or not row.gate_id.endswith("_A"):
            continue
        occurred_at = _local_datetime(row.occurred_at)
        key = (row.employee_id, occurred_at.date())
        if key not in late_daily or occurred_at < _local_datetime(late_daily[key].occurred_at):
            late_daily[key] = row
    late_rows = sorted(
        [row for row in late_daily.values() if _is_late_time(_local_datetime(row.occurred_at).time())],
        key=lambda row: _local_datetime(row.occurred_at),
        reverse=True,
    )[:limit]
    return [
        {
            "id": f"late:{_local_date(row.occurred_at)}:{row.employee_id}",
            "employeeId": row.employee_id,
            "displayName": row.display_name,
            "departmentId": row.department_id,
            "type": "late_arrival",
            "typeLabel": "遲到人員",
            "hours": _local_datetime(row.occurred_at).strftime("%H:%M"),
            "occurredAt": row.occurred_at.isoformat(),
            "note": row.remark or "待主管確認",
        }
        for row in late_rows
    ]


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
    override_visible_ids: list[str] | None = None,
):
    query = select(AccessEvent).options(selectinload(AccessEvent.employee))
    visible_ids = override_visible_ids if override_visible_ids is not None else _visible_department_ids(db, current_user, department_id)
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


def _dashboard_event_rows(
    db: Session,
    current_user: UserAccount | None,
    department_id: str | None,
    from_time: datetime,
    to_time: datetime,
):
    query = select(
        AccessEvent.id,
        AccessEvent.employee_id,
        AccessEvent.gate_id,
        AccessEvent.direction,
        AccessEvent.decision,
        AccessEvent.reason,
        AccessEvent.latency_ms,
        AccessEvent.remark,
        AccessEvent.occurred_at,
        Employee.department_id,
        Employee.display_name,
    )
    visible_ids = _visible_department_ids(db, current_user, department_id)
    if visible_ids is not None:
        query = query.join(Employee, AccessEvent.employee_id == Employee.employee_id)
        query = query.where(Employee.department_id.in_(visible_ids))
    else:
        query = query.outerjoin(Employee, AccessEvent.employee_id == Employee.employee_id)
    if current_user is not None and current_user.role == "EMPLOYEE" and current_user.employee_id:
        query = query.where(AccessEvent.employee_id == current_user.employee_id)
    query = query.where(AccessEvent.occurred_at >= from_time, AccessEvent.occurred_at <= to_time)
    query = query.order_by(AccessEvent.occurred_at.asc(), AccessEvent.id.asc())
    return db.execute(query).all()


def _multi_dept_visible_ids(db: Session, current_user: UserAccount | None, department_ids: list[str]) -> list[str] | None:
    """Like _visible_department_ids but expands multiple depts (each with descendants) and unions them."""
    if not department_ids:
        return _visible_department_ids(db, current_user, None)
    if len(department_ids) == 1:
        return _visible_department_ids(db, current_user, department_ids[0])
    requested_ids: set[str] = set()
    for dept_id in department_ids:
        requested_ids.add(dept_id)
        requested_ids.update(get_descendant_department_ids(db, dept_id))
    if current_user is None:
        return []
    visible_ids = get_visible_department_ids(db, current_user)
    if visible_ids is None:
        return sorted(requested_ids)
    return sorted(requested_ids.intersection(visible_ids)) or ["__none__"]


def _visible_department_ids(db: Session, current_user: UserAccount | None, department_id: str | None) -> list[str] | None:
    requested_ids: set[str] | None = None
    if department_id:
        requested_ids = {department_id, *get_descendant_department_ids(db, department_id)}

    if current_user is None:
        # Anonymous requests must never see data. Returning an empty list
        # (not None) filters every scoped query down to zero rows.
        return []

    visible_ids = get_visible_department_ids(db, current_user)
    if requested_ids is not None:
        if visible_ids is None:
            return sorted(requested_ids)
        return sorted(requested_ids.intersection(visible_ids))
    return visible_ids


def _local_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=TAIPEI)
    return value.astimezone(TAIPEI)


def _local_date(value: datetime) -> date:
    return _local_datetime(value).date()


def _weekday_label(value: date) -> str:
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][value.weekday()]


def _counter_top_item(counter: Counter[str]) -> dict[str, Any] | None:
    if not counter:
        return None
    key, count = counter.most_common(1)[0]
    return {"key": key, "count": count}


def _report_center_excluded_department_ids(current_user: UserAccount | None) -> set[str]:
    if current_user is None or current_user.role not in {"MANAGER", "EXECUTIVE", "ADMIN"}:
        return set()
    if current_user.employee is None or current_user.employee.department_id is None:
        return set()
    return {current_user.employee.department_id}


def _latest_consecutive_day_count(values: set[date]) -> int:
    if not values:
        return 0

    current = max(values)
    streak = 1
    while current - timedelta(days=1) in values:
        streak += 1
        current -= timedelta(days=1)
    return streak
