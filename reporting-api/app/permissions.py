from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Department, UserAccount, UserDepartmentScope


GLOBAL_REPORT_ROLES = {"ADMIN", "EXECUTIVE"}


def user_can_view_all_departments(user: UserAccount) -> bool:
    return user.role in GLOBAL_REPORT_ROLES


def get_visible_department_ids(db: Session, user: UserAccount) -> list[str] | None:
    if user_can_view_all_departments(user):
        return None

    scopes = db.scalars(
        select(UserDepartmentScope).where(UserDepartmentScope.user_id == user.user_id)
    ).all()
    visible: set[str] = set()

    for scope in scopes:
        visible.add(scope.department_id)
        if scope.include_descendants:
            visible.update(get_descendant_department_ids(db, scope.department_id))

    if not visible and user.employee and user.employee.department_id:
        visible.add(user.employee.department_id)

    return sorted(visible)


def get_descendant_department_ids(db: Session, department_id: str) -> list[str]:
    department_tree = select(Department.department_id).where(
        Department.parent_department_id == department_id
    )
    department_tree = department_tree.cte(name="department_tree", recursive=True)

    descendants = select(Department.department_id).where(
        Department.parent_department_id == department_tree.c.department_id
    )
    department_tree = department_tree.union_all(descendants)

    return list(db.scalars(select(department_tree.c.department_id)).all())
