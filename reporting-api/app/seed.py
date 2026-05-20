import os

from sqlalchemy import select, text

from app.database import SessionLocal
from app.models import Department, Employee, UserAccount, UserDepartmentScope
from app.security import hash_password


DEMO_PASSWORD = "demo123"
DEMO_DEPARTMENTS = ("OPS_A", "FAB_A", "FAB_B", "SECURITY")
BATCH_SIZE = 1000


def seed_demo_data() -> None:
    with SessionLocal() as db:
        departments = [
            Department(department_id="TSMC", name="TSMC Demo HQ"),
            Department(department_id="UNASSIGNED", name="Unassigned"),
            Department(department_id="FAB_A", name="Fab A", parent_department_id="TSMC"),
            Department(department_id="FAB_B", name="Fab B", parent_department_id="TSMC"),
            Department(department_id="SECURITY", name="Security", parent_department_id="TSMC"),
            Department(department_id="OPS_A", name="Operations A", parent_department_id="FAB_A"),
        ]
        for department in departments:
            existing = db.get(Department, department.department_id)
            if existing is None:
                db.add(department)
            else:
                existing.name = department.name
                existing.parent_department_id = department.parent_department_id

        employees = [
            Employee(employee_id="ADMIN001", display_name="Admin User", department_id="SECURITY"),
            Employee(employee_id="EXEC001", display_name="Executive User", department_id="TSMC"),
            Employee(employee_id="MGR001", display_name="Fab A Manager", department_id="FAB_A"),
            Employee(employee_id="EMP001", display_name="Fab A Operator", department_id="OPS_A", manager_employee_id="MGR001"),
            Employee(employee_id="EMP002", display_name="Fab B Operator", department_id="FAB_B", manager_employee_id="MGR001"),
        ]
        for employee in employees:
            existing = db.get(Employee, employee.employee_id)
            if existing is None:
                db.add(employee)
            else:
                existing.display_name = employee.display_name
                existing.department_id = employee.department_id
                existing.manager_employee_id = employee.manager_employee_id

        db.flush()

        # Ensure exactly one top-level manager (unique) with no manager
        # and ensure all other employees have a valid manager and their
        # department is the same as or a descendant of their manager's department.
        all_departments = {d.department_id: d for d in db.scalars(select(Department)).all()}

        def get_ancestors(dept_id: str | None) -> list[str]:
            if not dept_id:
                return []
            res = []
            cur = dept_id
            while cur:
                res.append(cur)
                cur = all_departments.get(cur).parent_department_id if all_departments.get(cur) else None
            return res

        all_emps = {e.employee_id: e for e in db.scalars(select(Employee)).all()}
        # Choose default top manager: prefer ADMIN001 if present, else pick first employee
        top_manager_id = 'ADMIN001' if 'ADMIN001' in all_emps else (next(iter(all_emps)) if all_emps else None)
        if top_manager_id is not None:
            # clear manager for top
            top = all_emps[top_manager_id]
            top.manager_employee_id = None

        for emp_id, emp in all_emps.items():
            if top_manager_id is not None and emp_id == top_manager_id:
                continue

            # If manager is set but doesn't exist, reset it
            if emp.manager_employee_id and emp.manager_employee_id not in all_emps:
                emp.manager_employee_id = None

            # If no manager, try to find one in ancestor departments
            if not emp.manager_employee_id:
                emp_dept = emp.department_id
                chosen = None
                if emp_dept:
                    ancestors = get_ancestors(emp_dept)
                    # prefer manager in nearest ancestor dept
                    for cand in all_emps.values():
                        if cand.employee_id == emp.employee_id:
                            continue
                        if cand.department_id and cand.department_id in ancestors:
                            chosen = cand
                            break

                if chosen is None:
                    # fallback to top manager
                    emp.manager_employee_id = top_manager_id
                else:
                    emp.manager_employee_id = chosen.employee_id

            # Ensure employee department is same as or descendant of manager's department
            mgr = db.get(Employee, emp.manager_employee_id) if emp.manager_employee_id else None
            if mgr is not None and mgr.department_id:
                if not emp.department_id or mgr.department_id not in get_ancestors(emp.department_id):
                    emp.department_id = mgr.department_id


        users = [
            ("admin", "ADMIN", "ADMIN001"),
            ("executive", "EXECUTIVE", "EXEC001"),
            ("manager", "MANAGER", "MGR001"),
            ("employee", "EMPLOYEE", "EMP001"),
        ]
        for username, role, employee_id in users:
            user = db.scalar(select(UserAccount).where(UserAccount.username == username))
            if user is None:
                user = UserAccount(username=username)
                db.add(user)
            user.role = role
            user.employee_id = employee_id
            user.password_hash = hash_password(DEMO_PASSWORD)
            user.is_active = True

        db.flush()

        manager = db.scalar(select(UserAccount).where(UserAccount.username == "manager"))
        if manager is not None:
            existing_scope = db.scalar(
                select(UserDepartmentScope).where(
                    UserDepartmentScope.user_id == manager.user_id,
                    UserDepartmentScope.department_id == "FAB_A",
                )
            )
            if existing_scope is None:
                db.add(
                    UserDepartmentScope(
                        user_id=manager.user_id,
                        department_id="FAB_A",
                        include_descendants=True,
                    )
                )
            else:
                existing_scope.include_descendants = True

        generated_count = seed_generated_demo_employees(db)
        db.commit()
        if generated_count:
            print(f"Seeded {generated_count} generated demo employees.")


def seed_generated_demo_employees(db) -> int:
    seeded = 0
    seeded += upsert_extra_demo_employee(
        db,
        os.getenv("DEMO_BASIC_EMPLOYEE_ID"),
        "Basic Anti-Passback Demo Operator",
        "OPS_A",
        "MGR001",
    )
    seeded += upsert_extra_demo_employee(
        db,
        os.getenv("DEMO_RECOVERY_EMPLOYEE_ID"),
        "Redis Recovery Demo Operator",
        "OPS_A",
        "MGR001",
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
    manager_employee_id: str,
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
    if department_id in {"OPS_A", "FAB_A"}:
        return "MGR001"
    return None


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
