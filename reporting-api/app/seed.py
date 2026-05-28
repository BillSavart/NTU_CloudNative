from sqlalchemy import delete, select, text

from app.config import get_settings
from app.database import SessionLocal
from app.models import Department, Employee, UserAccount, UserDepartmentScope
from app.security import hash_password


DEMO_PASSWORD = get_settings().demo_seed_password
BATCH_SIZE = 1000
FAB_COUNT = 22
FAB_UNITS = ("RD", "IT", "PE", "EE")
LEGACY_DEPARTMENT_IDS = ("OPS_A", "FAB_A", "FAB_B", "SECURITY")
LEGACY_EMPLOYEE_IDS = ("EXEC001", "MGR001", "MGR002", "MGR003", "ADMIN001", "EMP001", "EMP002")
LEGACY_USERNAMES = ("admin", "manager", "manager_fab_b", "manager_security")

FAB_MANAGER_NAMES = {
    1: "Bill Wang",
    2: "Ichigo",
    3: "Steven Lai",
    4: "Amy Huang",
    5: "High Ray",
    6: "Emily Chen",
    7: "David Lin",
    8: "Sophia Chang",
    9: "Daniel Wu",
    10: "Grace Liu",
    11: "Jason Lee",
    12: "Michelle Tsai",
    13: "Ryan Hsu",
    14: "Olivia Yang",
    15: "Andrew Kuo",
    16: "Teresa Wang",
    17: "Eric Huang",
    18: "Natalie Chou",
    19: "Victor Chen",
    20: "Karen Lin",
    21: "George Wang",
    22: "Iris Hsieh",
}
UNIT_MANAGER_NAMES = {
    (1, "RD"): "Ethan Chen",
    (1, "IT"): "Lily Wang",
    (1, "PE"): "Marcus Lin",
    (1, "EE"): "Nina Huang",
}

DEPARTMENT_PARENT_IDS = {
    "TSMC": None,
    **{f"fab_{fab_no}": "TSMC" for fab_no in range(1, FAB_COUNT + 1)},
    **{
        f"{unit}_{fab_no}": f"fab_{fab_no}"
        for fab_no in range(1, FAB_COUNT + 1)
        for unit in FAB_UNITS
    },
}
DEMO_DEPARTMENTS = tuple(
    f"{unit}_{fab_no}"
    for fab_no in range(1, FAB_COUNT + 1)
    for unit in FAB_UNITS
)


def executive_employee() -> dict[str, str | None]:
    return {
        "employee_id": "100000",
        "display_name": "CC Wei",
        "department_id": "TSMC",
        "manager_employee_id": None,
    }


def fab_manager_employee(fab_no: int) -> dict[str, str | None]:
    return {
        "employee_id": f"100{fab_no:03d}",
        "display_name": FAB_MANAGER_NAMES[fab_no],
        "department_id": f"fab_{fab_no}",
        "manager_employee_id": "100000",
    }


def unit_manager_employee(fab_no: int, unit: str) -> dict[str, str | None]:
    unit_offsets = {"RD": 1, "IT": 2, "PE": 3, "EE": 4}
    display_name = UNIT_MANAGER_NAMES.get((fab_no, unit), generated_unit_manager_name(fab_no, unit))
    return {
        "employee_id": f"{10 + unit_offsets[unit]}{fab_no:04d}",
        "display_name": display_name,
        "department_id": f"{unit}_{fab_no}",
        "manager_employee_id": f"100{fab_no:03d}",
    }


def generated_unit_manager_name(fab_no: int, unit: str) -> str:
    first_names = (
        "Aaron", "Bella", "Calvin", "Diana", "Edward", "Fiona", "Gavin", "Helen",
        "Isaac", "Julia", "Keith", "Laura", "Martin", "Nora", "Oscar", "Paula",
        "Quentin", "Rita", "Samuel", "Tina", "Ulrich", "Vicky", "Walter", "Yvonne",
    )
    last_names = (
        "Chen", "Lin", "Wang", "Huang", "Lee", "Chang", "Liu", "Wu", "Tsai",
        "Hsu", "Yang", "Kuo", "Chou", "Hsieh", "Ho", "Tang", "Yu", "Shen",
        "Kang", "Fang", "Hsiao", "Cheng", "Pan", "Su",
    )
    unit_index = FAB_UNITS.index(unit)
    idx = (fab_no - 1) * len(FAB_UNITS) + unit_index + 4
    return f"{first_names[idx % len(first_names)]} {last_names[(idx // len(first_names)) % len(last_names)]}"


def yp_hung_employee() -> dict[str, str | None]:
    return {
        "employee_id": "199001",
        "display_name": "YP Hung",
        "department_id": "EE_1",
        "manager_employee_id": unit_manager_employee(1, "EE")["employee_id"],
    }


DEMO_EMPLOYEES = [
    executive_employee(),
    *[fab_manager_employee(fab_no) for fab_no in range(1, FAB_COUNT + 1)],
    *[
        unit_manager_employee(fab_no, unit)
        for fab_no in range(1, FAB_COUNT + 1)
        for unit in FAB_UNITS
    ],
    yp_hung_employee(),
]

DEMO_MANAGER_BY_DEPARTMENT = {
    **{f"fab_{fab_no}": "100000" for fab_no in range(1, FAB_COUNT + 1)},
    **{
        f"{unit}_{fab_no}": unit_manager_employee(fab_no, unit)["employee_id"]
        for fab_no in range(1, FAB_COUNT + 1)
        for unit in FAB_UNITS
    },
}


def seed_demo_data() -> None:
    if not DEMO_PASSWORD:
        raise RuntimeError("DEMO_SEED_PASSWORD must be set before seeding demo accounts")

    with SessionLocal() as db:
        cleanup_legacy_demo_data(db)

        for department_id, parent_department_id in DEPARTMENT_PARENT_IDS.items():
            existing = db.get(Department, department_id)
            if existing is None:
                db.add(
                    Department(
                        department_id=department_id,
                        name=department_name(department_id),
                        parent_department_id=parent_department_id,
                    )
                )
            else:
                existing.name = department_name(department_id)
                existing.parent_department_id = parent_department_id

        for employee in DEMO_EMPLOYEES:
            existing = db.get(Employee, employee["employee_id"])
            if existing is None:
                db.add(Employee(**employee))
            else:
                existing.display_name = employee["display_name"]
                existing.department_id = employee["department_id"]
                existing.manager_employee_id = employee["manager_employee_id"]

        db.flush()
        db.execute(delete(UserAccount).where(UserAccount.username == "admin"))

        users = [("executive", "EXECUTIVE", "100000")]
        users.extend((f"fab_{fab_no}_manager", "MANAGER", f"100{fab_no:03d}") for fab_no in range(1, FAB_COUNT + 1))
        users.extend(
            (
                f"{unit.lower()}_{fab_no}_manager",
                "MANAGER",
                unit_manager_employee(fab_no, unit)["employee_id"],
            )
            for fab_no in range(1, FAB_COUNT + 1)
            for unit in FAB_UNITS
        )
        users.append(("employee", "EMPLOYEE", "199001"))

        for username, role, employee_id in users:
            user = db.scalar(select(UserAccount).where(UserAccount.username == username))
            if user is None:
                user = UserAccount(username=username)
                db.add(user)
            user.role = role
            user.employee_id = employee_id
            user.email = f"{username}@demo.local"
            user.password_hash = hash_password(DEMO_PASSWORD)
            user.is_active = True

        db.flush()

        manager_scopes = {
            **{f"fab_{fab_no}_manager": f"fab_{fab_no}" for fab_no in range(1, FAB_COUNT + 1)},
            **{
                f"{unit.lower()}_{fab_no}_manager": f"{unit}_{fab_no}"
                for fab_no in range(1, FAB_COUNT + 1)
                for unit in FAB_UNITS
            },
        }
        for username, department_id in manager_scopes.items():
            manager = db.scalar(select(UserAccount).where(UserAccount.username == username))
            if manager is not None:
                upsert_department_scope(db, manager.user_id, department_id)

        generated_count = seed_generated_demo_employees(db)
        db.commit()
        if generated_count:
            print(f"Seeded {generated_count} generated demo employees.")


def cleanup_legacy_demo_data(db) -> None:
    db.execute(
        text(
            """
            DELETE FROM access_events
            WHERE employee_id IN (
                SELECT employee_id
                FROM employees
                WHERE employee_id = ANY(:legacy_employee_ids)
                   OR department_id = ANY(:legacy_department_ids)
            )
            """
        ),
        {
            "legacy_employee_ids": list(LEGACY_EMPLOYEE_IDS),
            "legacy_department_ids": list(LEGACY_DEPARTMENT_IDS),
        },
    )
    db.execute(
        text(
            """
            DELETE FROM user_department_scopes
            WHERE department_id = ANY(:legacy_department_ids)
               OR user_id IN (
                   SELECT user_id
                   FROM user_accounts
                   WHERE username = ANY(:legacy_usernames)
                      OR employee_id = ANY(:legacy_employee_ids)
               )
            """
        ),
        {
            "legacy_department_ids": list(LEGACY_DEPARTMENT_IDS),
            "legacy_usernames": list(LEGACY_USERNAMES),
            "legacy_employee_ids": list(LEGACY_EMPLOYEE_IDS),
        },
    )
    db.execute(
        text(
            """
            DELETE FROM user_accounts
            WHERE username = ANY(:legacy_usernames)
               OR employee_id = ANY(:legacy_employee_ids)
            """
        ),
        {
            "legacy_usernames": list(LEGACY_USERNAMES),
            "legacy_employee_ids": list(LEGACY_EMPLOYEE_IDS),
        },
    )
    db.execute(
        text(
            """
            UPDATE employees
            SET manager_employee_id = NULL
            WHERE manager_employee_id = ANY(:legacy_employee_ids)
            """
        ),
        {"legacy_employee_ids": list(LEGACY_EMPLOYEE_IDS)},
    )
    db.execute(
        text(
            """
            DELETE FROM employees
            WHERE employee_id = ANY(:legacy_employee_ids)
               OR department_id = ANY(:legacy_department_ids)
            """
        ),
        {
            "legacy_employee_ids": list(LEGACY_EMPLOYEE_IDS),
            "legacy_department_ids": list(LEGACY_DEPARTMENT_IDS),
        },
    )
    db.execute(
        text(
            """
            DELETE FROM departments
            WHERE department_id = ANY(:legacy_department_ids)
            """
        ),
        {"legacy_department_ids": list(LEGACY_DEPARTMENT_IDS)},
    )


def department_name(department_id: str) -> str:
    if department_id == "TSMC":
        return "TSMC"
    if department_id.startswith("fab_"):
        return f"Fab {department_id.split('_')[1]}"
    unit, fab_no = department_id.split("_")
    return f"{unit} Fab {fab_no}"


def upsert_department_scope(db, user_id: int, department_id: str) -> None:
    existing_scope = db.scalar(
        select(UserDepartmentScope).where(
            UserDepartmentScope.user_id == user_id,
            UserDepartmentScope.department_id == department_id,
        )
    )
    if existing_scope is None:
        db.add(
            UserDepartmentScope(
                user_id=user_id,
                department_id=department_id,
                include_descendants=True,
            )
        )
    else:
        existing_scope.include_descendants = True


def seed_generated_demo_employees(db) -> int:
    seeded = 0
    seeded += upsert_extra_demo_employee(
        db,
        os.getenv("DEMO_BASIC_EMPLOYEE_ID"),
        "Basic Anti-Passback Demo Operator",
        "EE_1",
        manager_for_department("EE_1"),
    )
    seeded += upsert_extra_demo_employee(
        db,
        os.getenv("DEMO_RECOVERY_EMPLOYEE_ID"),
        "Redis Recovery Demo Operator",
        "EE_1",
        manager_for_department("EE_1"),
    )

    load_prefix = os.getenv("DEMO_LOAD_EMPLOYEE_PREFIX", "").strip()
    load_count = parse_positive_int(os.getenv("DEMO_LOAD_EMPLOYEES"), default=0)
    if load_prefix and load_count > 0:
        seeded += upsert_load_demo_employees(db, load_prefix, load_count)

    return seeded


def parse_positive_int(value: str | None, default: int) -> int:
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return max(parsed, 0)


def upsert_extra_demo_employee(
    db,
    employee_id: str | None,
    display_name: str,
    department_id: str,
    manager_employee_id: str | None,
) -> int:
    if not employee_id:
        return 0
    upsert_employees(
        db,
        [
            {
                "employee_id": employee_id,
                "display_name": display_name,
                "department_id": department_id,
                "manager_employee_id": manager_employee_id,
            }
        ],
    )
    return 1


def upsert_load_demo_employees(db, prefix: str, count: int) -> int:
    for start in range(1, count + 1, BATCH_SIZE):
        end = min(start + BATCH_SIZE - 1, count)
        rows = []
        for employee_number in range(start, end + 1):
            department_id = DEMO_DEPARTMENTS[(employee_number - 1) % len(DEMO_DEPARTMENTS)]
            rows.append(
                {
                    "employee_id": f"{prefix}{employee_number:06d}",
                    "display_name": f"Demo Operator {employee_number:06d}",
                    "department_id": department_id,
                    "manager_employee_id": manager_for_department(department_id),
                }
            )
        upsert_employees(db, rows)
    return count


def manager_for_department(department_id: str) -> str | None:
    return DEMO_MANAGER_BY_DEPARTMENT[department_id]


def upsert_employees(db, rows: list[dict[str, str | None]]) -> None:
    db.execute(
        text(
            """
            INSERT INTO employees (
                employee_id,
                display_name,
                department_id,
                manager_employee_id,
                last_known_state
            )
            VALUES (
                :employee_id,
                :display_name,
                :department_id,
                :manager_employee_id,
                'UNKNOWN'
            )
            ON CONFLICT (employee_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                department_id = EXCLUDED.department_id,
                manager_employee_id = EXCLUDED.manager_employee_id,
                updated_at = now()
            """
        ),
        rows,
    )


if __name__ == "__main__":
    seed_demo_data()
    print("Seeded demo reporting data.")
