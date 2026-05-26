from __future__ import annotations

import os

from sqlalchemy import text

from app.database import SessionLocal


DEFAULT_DENIED_EVENTS = 12_000


def main() -> None:
    denied_events = parse_positive_int("PATCH_DENIED_EVENTS", DEFAULT_DENIED_EVENTS)
    with SessionLocal() as db:
        dates = db.execute(text("SELECT count(DISTINCT occurred_at::date) FROM access_events")).scalar_one()
        employees = db.execute(text("SELECT count(*) FROM employees")).scalar_one()
        if dates == 0 or employees == 0:
            print("No existing fake data found. Run fake_data first, then run this patch.", flush=True)
            return

        supervisor_rows = patch_missing_supervisor_attendance(db)
        denied_rows = patch_denied_events(db, denied_events)
        db.commit()

    print(f"Patched supervisor attendance events: {supervisor_rows}", flush=True)
    print(f"Patched denied access events: {denied_rows}", flush=True)


def parse_positive_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    try:
        return max(int(value), 0)
    except ValueError:
        return default


def patch_missing_supervisor_attendance(db) -> int:
    result = db.execute(
        text(
            """
            WITH work_days AS (
                SELECT DISTINCT occurred_at::date AS work_date
                FROM access_events
                WHERE decision = 'GRANTED'
                  AND occurred_at::time >= time '08:00'
                  AND occurred_at::time < time '23:59:59'
            ),
            missing_staff AS (
                SELECT
                    ua.username,
                    emp.employee_id,
                    emp.department_id,
                    COALESCE((regexp_match(emp.department_id, '([0-9]+)$'))[1], '1') AS fab_no
                FROM user_accounts ua
                JOIN employees emp ON emp.employee_id = ua.employee_id
                WHERE ua.role IN ('EXECUTIVE', 'MANAGER')
                  AND NOT EXISTS (
                      SELECT 1
                      FROM access_events ae
                      WHERE ae.employee_id = emp.employee_id
                        AND ae.decision = 'GRANTED'
                  )
            ),
            hashes AS (
                SELECT
                    missing_staff.employee_id,
                    missing_staff.fab_no,
                    work_days.work_date,
                    abs(('x' || substr(md5(work_days.work_date::text || missing_staff.employee_id || 'patch-in'), 1, 8))::bit(32)::bigint) AS in_hash,
                    abs(('x' || substr(md5(work_days.work_date::text || missing_staff.employee_id || 'patch-out'), 1, 8))::bit(32)::bigint) AS out_hash,
                    abs(('x' || substr(md5(work_days.work_date::text || missing_staff.employee_id || 'patch-move'), 1, 8))::bit(32)::bigint) AS move_hash
                FROM missing_staff
                CROSS JOIN work_days
            ),
            checkins AS (
                SELECT
                    concat('patch-supervisor-attendance', chr(58), work_date, chr(58), employee_id, chr(58), 'in') AS request_id,
                    employee_id,
                    'gate_' || fab_no || '_A' AS gate_id,
                    'IN' AS direction,
                    'GRANTED' AS decision,
                    'ACCESS_ALLOWED' AS reason,
                    'OUT' AS previous_state,
                    'IN' AS current_state,
                    4 + (in_hash % 10)::int AS latency_ms,
                    CASE
                        WHEN in_hash % 100 < 3 THEN
                            work_date + time '08:31'
                            + ((in_hash % 20) * interval '1 minute')
                            + (((in_hash / 17) % 60) * interval '1 second')
                        ELSE
                            work_date + time '08:02'
                            + ((in_hash % 27) * interval '1 minute')
                            + (((in_hash / 17) % 60) * interval '1 second')
                    END AS occurred_at
                FROM hashes
            ),
            checkouts AS (
                SELECT
                    concat('patch-supervisor-attendance', chr(58), work_date, chr(58), employee_id, chr(58), 'out') AS request_id,
                    employee_id,
                    'gate_' || fab_no || '_A' AS gate_id,
                    'OUT' AS direction,
                    'GRANTED' AS decision,
                    'ACCESS_ALLOWED' AS reason,
                    'IN' AS previous_state,
                    'OUT' AS current_state,
                    4 + (out_hash % 10)::int AS latency_ms,
                    CASE
                        WHEN out_hash % 1000 < 12 THEN
                            work_date + time '20:40'
                            + ((out_hash % 120) * interval '1 minute')
                            + (((out_hash / 23) % 60) * interval '1 second')
                        ELSE
                            work_date + time '17:05'
                            + ((out_hash % 130) * interval '1 minute')
                            + (((out_hash / 23) % 60) * interval '1 second')
                    END AS occurred_at
                FROM hashes
            ),
            move_out AS (
                SELECT
                    concat('patch-supervisor-attendance', chr(58), work_date, chr(58), employee_id, chr(58), 'move-out') AS request_id,
                    employee_id,
                    'gate_' || fab_no || '_' || chr(66 + (move_hash % 4)::int) AS gate_id,
                    'OUT' AS direction,
                    'GRANTED' AS decision,
                    'ACCESS_ALLOWED' AS reason,
                    'IN' AS previous_state,
                    'OUT' AS current_state,
                    4 + (move_hash % 10)::int AS latency_ms,
                    work_date + time '11:15'
                        + ((move_hash % 150) * interval '1 minute')
                        + (((move_hash / 31) % 60) * interval '1 second') AS occurred_at
                FROM hashes
                WHERE move_hash % 100 < 28
            ),
            move_in AS (
                SELECT
                    replace(request_id, 'move-out', 'move-in') AS request_id,
                    employee_id,
                    gate_id,
                    'IN' AS direction,
                    'GRANTED' AS decision,
                    'ACCESS_ALLOWED' AS reason,
                    'OUT' AS previous_state,
                    'IN' AS current_state,
                    latency_ms,
                    occurred_at + ((600 + (extract(epoch FROM occurred_at)::bigint % 1800)) * interval '1 second') AS occurred_at
                FROM move_out
            ),
            inserted AS (
                INSERT INTO access_events (
                    request_id,
                    employee_id,
                    gate_id,
                    direction,
                    decision,
                    reason,
                    previous_state,
                    current_state,
                    latency_ms,
                    remark,
                    occurred_at
                )
                SELECT request_id, employee_id, gate_id, direction, decision, reason,
                       previous_state, current_state, latency_ms, NULL, occurred_at
                FROM checkins
                UNION ALL
                SELECT request_id, employee_id, gate_id, direction, decision, reason,
                       previous_state, current_state, latency_ms, NULL, occurred_at
                FROM checkouts
                UNION ALL
                SELECT request_id, employee_id, gate_id, direction, decision, reason,
                       previous_state, current_state, latency_ms, NULL, occurred_at
                FROM move_out
                UNION ALL
                SELECT request_id, employee_id, gate_id, direction, decision, reason,
                       previous_state, current_state, latency_ms, NULL, occurred_at
                FROM move_in
                ON CONFLICT (request_id) DO NOTHING
                RETURNING 1
            )
            SELECT count(*) FROM inserted
            """
        )
    )
    refresh_staff_states(db)
    return int(result.scalar_one())


def refresh_staff_states(db) -> None:
    db.execute(
        text(
            """
            WITH staff AS (
                SELECT employee_id
                FROM user_accounts
                WHERE role IN ('EXECUTIVE', 'MANAGER')
                  AND employee_id IS NOT NULL
            ),
            latest AS (
                SELECT DISTINCT ON (ae.employee_id)
                    ae.employee_id,
                    ae.current_state,
                    ae.occurred_at
                FROM access_events ae
                JOIN staff ON staff.employee_id = ae.employee_id
                WHERE ae.decision = 'GRANTED'
                ORDER BY ae.employee_id, ae.occurred_at DESC, ae.id DESC
            )
            UPDATE employees emp
            SET last_known_state = latest.current_state,
                last_seen_at = latest.occurred_at,
                updated_at = now()
            FROM latest
            WHERE emp.employee_id = latest.employee_id
            """
        )
    )


def patch_denied_events(db, denied_events: int) -> int:
    if denied_events <= 0:
        return 0

    result = db.execute(
        text(
            """
            WITH days AS (
                SELECT
                    occurred_at::date AS work_date,
                    row_number() OVER (ORDER BY occurred_at::date) AS day_no,
                    count(*) OVER () AS day_count
                FROM access_events
                WHERE decision = 'GRANTED'
                GROUP BY occurred_at::date
            ),
            employees_ranked AS (
                SELECT
                    employee_id,
                    department_id,
                    COALESCE((regexp_match(department_id, '([0-9]+)$'))[1], '1') AS fab_no,
                    row_number() OVER (ORDER BY employee_id) AS employee_no,
                    count(*) OVER () AS employee_count
                FROM employees
                WHERE department_id IS NOT NULL
            ),
            planned AS (
                SELECT
                    n,
                    days.work_date,
                    employees_ranked.employee_id,
                    employees_ranked.fab_no,
                    abs(('x' || substr(md5(n::text || days.work_date::text || employees_ranked.employee_id || 'denied'), 1, 8))::bit(32)::bigint) AS event_hash
                FROM generate_series(1, :denied_events) AS n
                JOIN days ON days.day_no = 1 + ((n * 37) % days.day_count)
                JOIN employees_ranked
                  ON employees_ranked.employee_no = 1 + ((n * 7919) % employees_ranked.employee_count)
            ),
            denied AS (
                SELECT
                    concat('patch-denied-access', chr(58), work_date, chr(58), employee_id, chr(58), n) AS request_id,
                    employee_id,
                    'gate_' || fab_no || '_' || chr(65 + (event_hash % 5)::int) AS gate_id,
                    CASE WHEN event_hash % 2 = 0 THEN 'IN' ELSE 'OUT' END AS direction,
                    'DENIED' AS decision,
                    CASE
                        WHEN event_hash % 5 = 0 THEN 'UNKNOWN_BADGE'
                        WHEN event_hash % 5 = 1 THEN 'ACCESS_REVOKED'
                        WHEN event_hash % 5 = 2 THEN 'OUTSIDE_ALLOWED_WINDOW'
                        ELSE 'ANTI_PASSBACK'
                    END AS reason,
                    CASE WHEN event_hash % 2 = 0 THEN 'IN' ELSE 'OUT' END AS previous_state,
                    CASE WHEN event_hash % 2 = 0 THEN 'IN' ELSE 'OUT' END AS current_state,
                    5 + (event_hash % 18)::int AS latency_ms,
                    work_date + time '08:05'
                        + ((event_hash % 39000) * interval '1 second') AS occurred_at
                FROM planned
            ),
            inserted AS (
                INSERT INTO access_events (
                    request_id,
                    employee_id,
                    gate_id,
                    direction,
                    decision,
                    reason,
                    previous_state,
                    current_state,
                    latency_ms,
                    remark,
                    occurred_at
                )
                SELECT
                    request_id,
                    employee_id,
                    gate_id,
                    direction,
                    decision,
                    reason,
                    previous_state,
                    current_state,
                    latency_ms,
                    NULL,
                    occurred_at
                FROM denied
                WHERE occurred_at::time >= time '08:00'
                  AND occurred_at::time < time '23:59:59'
                ON CONFLICT (request_id) DO NOTHING
                RETURNING 1
            )
            SELECT count(*) FROM inserted
            """
        ),
        {"denied_events": denied_events},
    )
    return int(result.scalar_one())


if __name__ == "__main__":
    main()
