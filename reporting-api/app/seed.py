from sqlalchemy import select

from app.database import SessionLocal
from app.models import Department, Employee, UserAccount, UserDepartmentScope
from app.security import hash_password


DEMO_PASSWORD = "demo123"


def seed_demo_data() -> None:
    with SessionLocal() as db:
        departments = [
            Department(department_id="TSMC", name="TSMC Demo HQ"),
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

        db.commit()


if __name__ == "__main__":
    seed_demo_data()
    print("Seeded demo reporting data.")
