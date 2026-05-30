from __future__ import annotations

import os
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text

from app.database import SessionLocal
from app.seed import (
    DEMO_EMPLOYEES,
    DEMO_PASSWORD,
    FAB_UNITS,
    manager_for_department,
    seed_demo_data,
    unit_manager_employee,
    upsert_employees,
)


TAIPEI = ZoneInfo("Asia/Taipei")
DEFAULT_EMPLOYEE_COUNT = 90_000
DEFAULT_OPERATING_DAYS = 365
BATCH_SIZE = 5000

FIRST_NAMES = (
    "Michael", "Bill", "Jensen", "Kevin", "Amy", "Steven", "Grace", "David",
    "Sophia", "Daniel", "Emily", "Jason", "Michelle", "Ryan", "Olivia", "Andrew",
    "Teresa", "Eric", "Natalie", "Victor", "Karen", "George", "Iris", "Henry",
    "Laura", "Brian", "Jessica", "Patrick", "Angela", "Samuel", "Tiffany", "Justin",
    "Rachel", "Brandon", "Claire", "Derek", "Monica", "Peter", "Vivian", "Arthur",
    "Linda", "Howard", "Cindy", "Ethan", "Megan", "Aaron", "Chloe", "Dylan",
    "Alice", "Wendy", "Gary", "Sandy", "Oscar", "Fiona", "Louis", "Nora",
)
LAST_NAMES = (
    "Jackson", "Wang", "Huang", "Hart", "Chen", "Lin", "Lai", "Lee",
    "Chang", "Liu", "Wu", "Tsai", "Hsu", "Yang", "Kuo", "Chou",
    "Hsieh", "Ho", "Tang", "Yu", "Shen", "Kang", "Fang", "Hsiao",
    "Cheng", "Pan", "Su", "Yeh", "Kwan", "Lo", "Ma", "Tung",
    "Wei", "Hung", "Ko", "Tien", "Morris", "Cheney", "Austin", "Brooks",
    "Miller", "Davis", "Wilson", "Moore", "Taylor", "Anderson", "Thomas", "Martin",
    "Lewis", "Walker", "Hall", "Young", "King", "Wright", "Scott", "Green",
)


def main() -> None:
    employee_count = parse_positive_int("FAKE_EMPLOYEE_COUNT", DEFAULT_EMPLOYEE_COUNT)
    operating_days = parse_positive_int("FAKE_OPERATING_DAYS", DEFAULT_OPERATING_DAYS)
    attendance_employee_count = parse_positive_int("FAKE_ATTENDANCE_EMPLOYEES", employee_count)
    movement_pct = min(parse_positive_int("FAKE_MOVEMENT_PCT", 18), 100)
    max_moves_per_day = max(parse_positive_int("FAKE_MAX_MOVES_PER_DAY", 3), 1)
    include_weekends = parse_bool("FAKE_INCLUDE_WEEKENDS", False)

    seed_demo_data()
    with SessionLocal() as db:
        ordinary_count = max(employee_count - len(DEMO_EMPLOYEES), 0)
        seed_ordinary_employees(db, ordinary_count)
        db.commit()

        work_days = build_work_days(operating_days, include_weekends)
        print(
            f"Seeding {employee_count} employees and {len(work_days)} operating days "
            f"for up to {attendance_employee_count} employees.",
            flush=True,
        )
        seeded_until = datetime.now(TAIPEI).replace(microsecond=0)
        print(f"Seeding only events up to {seeded_until.isoformat()}.", flush=True)
        seed_attendance_events(db, work_days, attendance_employee_count, movement_pct, max_moves_per_day, seeded_until)
        prune_future_fake_events(db, seeded_until)
        refresh_employee_states(db)
        db.commit()

    print("Fake data seed completed.", flush=True)
    print_account_summary()


def parse_positive_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    try:
        return max(int(value), 0)
    except ValueError:
        return default


def parse_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y"}


def build_work_days(operating_days: int, include_weekends: bool) -> list[date]:
    # A 24/7 fab runs every calendar day. We always return every day; whether a
    # given employee works a given day (e.g. office staff skip weekends, shift
    # operators rotate days off) is decided per-employee inside the SQL. The
    # include_weekends flag is kept for backwards-compat but no longer filters.
    today = datetime.now(TAIPEI).date()
    start = today - timedelta(days=max(operating_days - 1, 0))
    return [start + timedelta(days=offset) for offset in range((today - start).days + 1)]


def seed_ordinary_employees(db, count: int) -> None:
    for start in range(0, count, BATCH_SIZE):
        end = min(start + BATCH_SIZE, count)
        rows = []
        for idx in range(start, end):
            employee_id = f"{200000 + idx:06d}"
            fab_no = (idx % 22) + 1
            unit = FAB_UNITS[(idx // 22) % len(FAB_UNITS)]
            department_id = f"{unit}_{fab_no}"
            rows.append(
                {
                    "employee_id": employee_id,
                    "display_name": human_name(idx),
                    "department_id": department_id,
                    "manager_employee_id": manager_for_department(department_id),
                }
            )
        upsert_employees(db, rows)
        if end % 25000 == 0 or end == count:
            print(f"Seeded ordinary employees: {end}/{count}", flush=True)


def human_name(idx: int) -> str:
    first = FIRST_NAMES[idx % len(FIRST_NAMES)]
    last = LAST_NAMES[(idx // len(FIRST_NAMES)) % len(LAST_NAMES)]
    return f"{first} {last}"


def seed_attendance_events(
    db,
    work_days: list[date],
    employee_count: int,
    movement_pct: int,
    max_moves_per_day: int,
    seeded_until: datetime,
) -> None:
    # 24/7 semiconductor-fab shift model. Each employee gets a stable shift
    # "bucket" from a hash of their id, so the population is split across shifts
    # that together cover the clock and keep the fab staffed at all hours:
    #
    #   bucket   share  shift          start   length   notes
    #   0-39     40%    day operator   07:30   12h      out ~19:30
    #   40-64    25%    office/eng     09:00    9h(+OT) weekdays only, frequent OT
    #   65-79    15%    night operator 19:30   12h      out ~07:30 NEXT day (overnight presence)
    #   80-89    10%    graveyard      00:00    8h      out ~08:00 (covers 00:00-08:00)
    #   90-99    10%    swing/late     15:00    8.5h    out ~23:30
    #
    # Per-day jitter on start (+/-15m), duration (-30..+120m) and occasional big
    # overtime (+90..240m) spreads work hours so they are NOT all identical.
    # Whether someone works a given day is also randomised (operators ~78%/day
    # all week; office ~93% on weekdays) so daily headcount varies realistically.
    #
    # "Currently inside" falls out naturally: events after seeded_until (now) are
    # pruned, so anyone mid-shift has their check-OUT removed and shows as IN.
    for day_index, work_day in enumerate(work_days, start=1):
        db.execute(
            text(
                """
                WITH target_employees AS (
                    SELECT
                        employee_id,
                        COALESCE((regexp_match(department_id, '([0-9]+)$'))[1], '1') AS fab_no
                    FROM employees
                    WHERE department_id IS NOT NULL
                      AND department_id <> 'TSMC'
                    ORDER BY employee_id
                    LIMIT :employee_count
                ),
                attrs AS (
                    SELECT
                        employee_id,
                        fab_no,
                        (abs(('x' || substr(md5(employee_id), 1, 8))::bit(32)::bigint) % 100) AS bucket,
                        abs(('x' || substr(md5(:work_date || employee_id || 'day'), 1, 8))::bit(32)::bigint) AS day_hash,
                        abs(('x' || substr(md5(:work_date || employee_id || 'move'), 1, 8))::bit(32)::bigint) AS move_hash,
                        EXTRACT(ISODOW FROM CAST(:work_date AS date))::int AS isodow
                    FROM target_employees
                ),
                plan AS (
                    SELECT
                        employee_id, fab_no, bucket, day_hash, move_hash,
                        CASE
                            WHEN bucket < 40 THEN 450    -- day operator   07:30
                            WHEN bucket < 65 THEN 540    -- office         09:00
                            WHEN bucket < 80 THEN 1170   -- night operator 19:30
                            WHEN bucket < 90 THEN 0      -- graveyard      00:00
                            ELSE 900                     -- swing          15:00
                        END AS base_start_min,
                        CASE
                            WHEN bucket < 40 THEN 720    -- 12h
                            WHEN bucket < 65 THEN 540    -- 9h office
                            WHEN bucket < 80 THEN 720    -- 12h
                            WHEN bucket < 90 THEN 480    -- 8h
                            ELSE 510                     -- 8.5h swing
                        END AS base_dur_min,
                        ((day_hash % 31) - 15) AS start_jitter_min,
                        (((day_hash / 7) % 151) - 30) AS dur_jitter_min,
                        CASE WHEN (day_hash / 3) % 100 < 8 THEN (90 + (day_hash % 151)) ELSE 0 END AS ot_min,
                        CASE
                            WHEN bucket >= 40 AND bucket < 65
                                THEN (isodow <= 5 AND (day_hash % 100) < 93)   -- office: weekdays, ~93%
                            ELSE ((day_hash % 100) < 78)                       -- operators: any day, ~78%
                        END AS works_today
                    FROM attrs
                ),
                sessions AS (
                    SELECT
                        employee_id,
                        fab_no,
                        move_hash,
                        (CAST(:work_date AS date)
                            + make_interval(mins => GREATEST(base_start_min + start_jitter_min, 0))) AS checkin_at,
                        (CAST(:work_date AS date)
                            + make_interval(mins => GREATEST(base_start_min + start_jitter_min, 0)
                                                   + GREATEST(base_dur_min + dur_jitter_min + ot_min, 120))) AS checkout_at
                    FROM plan
                    WHERE works_today
                ),
                checkins AS (
                    SELECT
                        concat('fake', chr(58), :work_date, chr(58), employee_id, chr(58), 'in') AS request_id,
                        employee_id,
                        'gate_' || fab_no || '_A' AS gate_id,
                        'IN' AS direction, 'GRANTED' AS decision, 'ACCESS_ALLOWED' AS reason,
                        'OUT' AS previous_state, 'IN' AS current_state,
                        3 + (move_hash % 12)::int AS latency_ms,
                        checkin_at AS occurred_at
                    FROM sessions
                ),
                checkouts AS (
                    SELECT
                        concat('fake', chr(58), :work_date, chr(58), employee_id, chr(58), 'out') AS request_id,
                        employee_id,
                        'gate_' || fab_no || '_A' AS gate_id,
                        'OUT' AS direction, 'GRANTED' AS decision, 'ACCESS_ALLOWED' AS reason,
                        'IN' AS previous_state, 'OUT' AS current_state,
                        3 + ((move_hash / 5) % 12)::int AS latency_ms,
                        checkout_at AS occurred_at
                    FROM sessions
                ),
                movers AS (
                    SELECT
                        employee_id, fab_no, move_hash, checkin_at, checkout_at,
                        1 + (move_hash % :max_moves_per_day)::int AS move_count
                    FROM sessions
                    WHERE move_hash % 100 < :movement_pct
                      AND checkout_at > checkin_at + interval '1 hour'
                ),
                move_slots AS (
                    SELECT
                        movers.employee_id, movers.fab_no, movers.checkin_at,
                        movers.checkout_at, movers.move_count, slot_no,
                        abs(('x' || substr(md5(:work_date || movers.employee_id || 'slot' || slot_no), 1, 8))::bit(32)::bigint) AS slot_hash
                    FROM movers
                    CROSS JOIN LATERAL generate_series(1, movers.move_count) AS slot_no
                ),
                move_out AS (
                    SELECT
                        concat('fake', chr(58), :work_date, chr(58), employee_id, chr(58), 'move-out-', slot_no) AS request_id,
                        employee_id,
                        'gate_' || fab_no || '_' || chr(66 + (slot_hash % 4)::int) AS gate_id,
                        'OUT' AS direction, 'GRANTED' AS decision, 'ACCESS_ALLOWED' AS reason,
                        'IN' AS previous_state, 'OUT' AS current_state,
                        4 + (slot_hash % 10)::int AS latency_ms,
                        checkin_at
                            + make_interval(secs => floor(
                                  extract(epoch FROM (checkout_at - checkin_at))
                                  * slot_no::double precision / (move_count + 1))::int)
                            - interval '15 minutes'
                            + make_interval(secs => (slot_hash % 600)::int) AS occurred_at,
                        slot_hash
                    FROM move_slots
                ),
                move_in AS (
                    SELECT
                        replace(request_id, 'move-out-', 'move-in-') AS request_id,
                        employee_id, gate_id,
                        'IN' AS direction, 'GRANTED' AS decision, 'ACCESS_ALLOWED' AS reason,
                        'OUT' AS previous_state, 'IN' AS current_state,
                        latency_ms,
                        occurred_at + make_interval(secs => (300 + ((slot_hash / 29) % 1200))::int) AS occurred_at
                    FROM move_out
                ),
                all_events AS (
                    SELECT request_id, employee_id, gate_id, direction, decision, reason,
                           previous_state, current_state, latency_ms, occurred_at FROM checkins
                    UNION ALL
                    SELECT request_id, employee_id, gate_id, direction, decision, reason,
                           previous_state, current_state, latency_ms, occurred_at FROM checkouts
                    UNION ALL
                    SELECT request_id, employee_id, gate_id, direction, decision, reason,
                           previous_state, current_state, latency_ms, occurred_at FROM move_out
                    UNION ALL
                    SELECT request_id, employee_id, gate_id, direction, decision, reason,
                           previous_state, current_state, latency_ms, occurred_at FROM move_in
                )
                INSERT INTO access_events (
                    request_id, employee_id, gate_id, direction, decision, reason,
                    previous_state, current_state, latency_ms, remark, occurred_at
                )
                SELECT request_id, employee_id, gate_id, direction, decision, reason,
                       previous_state, current_state, latency_ms, NULL, occurred_at
                FROM all_events
                WHERE occurred_at <= CAST(:seeded_until AS timestamptz)
                ON CONFLICT (request_id) DO NOTHING
                """
            ),
            {
                "work_date": work_day.isoformat(),
                "employee_count": employee_count,
                "movement_pct": movement_pct,
                "max_moves_per_day": max_moves_per_day,
                "seeded_until": seeded_until.isoformat(),
            },
        )
        if day_index % 25 == 0 or day_index == len(work_days):
            db.commit()
            print(f"Seeded attendance days: {day_index}/{len(work_days)}", flush=True)


def prune_future_fake_events(db, seeded_until: datetime) -> None:
    result = db.execute(
        text(
            """
            DELETE FROM access_events
            WHERE request_id LIKE 'fake:%'
              AND occurred_at > CAST(:seeded_until AS timestamptz)
            """
        ),
        {"seeded_until": seeded_until.isoformat()},
    )
    deleted = result.rowcount or 0
    if deleted:
        print(f"Removed future fake events: {deleted}", flush=True)


def refresh_employee_states(db) -> None:
    db.execute(
        text(
            """
            WITH latest AS (
                SELECT DISTINCT ON (employee_id)
                    employee_id,
                    current_state,
                    occurred_at
                FROM access_events
                ORDER BY employee_id, occurred_at DESC, id DESC
            )
            UPDATE employees
            SET last_known_state = latest.current_state,
                last_seen_at = latest.occurred_at,
                updated_at = now()
            FROM latest
            WHERE employees.employee_id = latest.employee_id
            """
        )
    )


def print_account_summary() -> None:
    accounts = [
        ("executive", "CC Wei", "all departments"),
        ("fab_1_manager", "Bill Wang", "fab_1"),
        ("fab_2_manager", "Ichigo", "fab_2"),
        ("fab_3_manager", "Steven Lai", "fab_3"),
        ("fab_4_manager", "Amy Huang", "fab_4"),
        ("fab_5_manager", "High Ray", "fab_5"),
        ("rd_1_manager", unit_manager_employee(1, "RD")["display_name"], "RD_1"),
        ("it_1_manager", unit_manager_employee(1, "IT")["display_name"], "IT_1"),
        ("pe_1_manager", unit_manager_employee(1, "PE")["display_name"], "PE_1"),
        ("ee_1_manager", unit_manager_employee(1, "EE")["display_name"], "EE_1"),
        ("employee", "YP Hung", "self only"),
    ]
    print("Login password for seeded accounts: " + DEMO_PASSWORD, flush=True)
    for username, display_name, scope in accounts:
        print(f"- {username}: {display_name}, scope={scope}", flush=True)


if __name__ == "__main__":
    main()
