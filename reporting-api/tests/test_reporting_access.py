import unittest
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models import AccessEvent, Department, Employee, UserAccount, UserDepartmentScope
from app.permissions import get_visible_department_ids
from app.repositories import get_employee_states, query_access_events
from app.security import create_session_token, hash_password, parse_session_token, verify_password
from tests.support import create_test_engine


class ReportingAccessTestCase(unittest.TestCase):
    def setUp(self) -> None:
        engine = create_test_engine()
        self.SessionLocal = sessionmaker(bind=engine)
        with self.SessionLocal() as db:
            self._seed(db)

    def test_manager_can_view_assigned_department_and_descendants(self) -> None:
        with self.SessionLocal() as db:
            manager = self._user(db, "manager")

            visible_ids = get_visible_department_ids(db, manager)
            result = get_employee_states(db, current_user=manager, department_id="FAB_A")

        self.assertEqual(visible_ids, ["FAB_A", "OPS_A"])
        self.assertEqual(result["total"], 2)
        self.assertEqual(
            {employee["employeeId"] for employee in result["items"]},
            {"MGR001", "EMP001"},
        )

    def test_employee_can_only_view_self_even_inside_visible_department(self) -> None:
        with self.SessionLocal() as db:
            employee = self._user(db, "employee")

            result = get_employee_states(db, current_user=employee, department_id="FAB_A")
            events = query_access_events(db, current_user=employee, department_id="FAB_A")

        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["employeeId"], "EMP001")
        self.assertEqual(events["total"], 1)
        self.assertEqual(events["items"][0]["employeeId"], "EMP001")

    def test_global_user_can_filter_department_with_descendants(self) -> None:
        with self.SessionLocal() as db:
            admin = self._user(db, "admin")

            result = query_access_events(db, current_user=admin, department_id="FAB_A")

        self.assertEqual(result["total"], 2)
        self.assertEqual(
            {event["employeeId"] for event in result["items"]},
            {"MGR001", "EMP001"},
        )

    def test_password_hash_and_session_token_round_trip(self) -> None:
        stored_hash = hash_password("demo123", salt=b"0123456789abcdef")
        self.assertTrue(verify_password("demo123", stored_hash))
        self.assertFalse(verify_password("wrong-password", stored_hash))

        token = create_session_token(42)
        self.assertEqual(parse_session_token(token), 42)
        self.assertIsNone(parse_session_token(token + "tampered"))

    def _seed(self, db: Session) -> None:
        db.add_all(
            [
                Department(department_id="TSMC", name="TSMC Demo HQ"),
                Department(department_id="FAB_A", name="Fab A", parent_department_id="TSMC"),
                Department(department_id="OPS_A", name="Operations A", parent_department_id="FAB_A"),
                Department(department_id="FAB_B", name="Fab B", parent_department_id="TSMC"),
            ]
        )
        db.add_all(
            [
                Employee(
                    employee_id="ADMIN001",
                    display_name="Admin User",
                    department_id="TSMC",
                    last_known_state="UNKNOWN",
                ),
                Employee(
                    employee_id="MGR001",
                    display_name="Fab A Manager",
                    department_id="FAB_A",
                    last_known_state="OUT",
                ),
                Employee(
                    employee_id="EMP001",
                    display_name="Fab A Operator",
                    department_id="OPS_A",
                    manager_employee_id="MGR001",
                    last_known_state="IN",
                ),
                Employee(
                    employee_id="EMP002",
                    display_name="Fab B Operator",
                    department_id="FAB_B",
                    manager_employee_id="MGR001",
                    last_known_state="IN",
                ),
            ]
        )
        db.add_all(
            [
                UserAccount(user_id=1, username="admin", role="ADMIN", employee_id="ADMIN001", is_active=True),
                UserAccount(user_id=2, username="manager", role="MANAGER", employee_id="MGR001", is_active=True),
                UserAccount(user_id=3, username="employee", role="EMPLOYEE", employee_id="EMP001", is_active=True),
            ]
        )
        db.add(
            UserDepartmentScope(
                id=1,
                user_id=2,
                department_id="FAB_A",
                include_descendants=True,
            )
        )
        occurred_at = datetime(2026, 5, 10, 14, 25, tzinfo=UTC)
        db.add_all(
            [
                AccessEvent(
                    id=1,
                    request_id="req-mgr",
                    employee_id="MGR001",
                    gate_id="GATE_01",
                    direction="OUT",
                    decision="GRANTED",
                    reason="OK",
                    previous_state="IN",
                    current_state="OUT",
                    latency_ms=5,
                    occurred_at=occurred_at,
                ),
                AccessEvent(
                    id=2,
                    request_id="req-emp-a",
                    employee_id="EMP001",
                    gate_id="GATE_02",
                    direction="IN",
                    decision="GRANTED",
                    reason="OK",
                    previous_state="OUT",
                    current_state="IN",
                    latency_ms=8,
                    occurred_at=occurred_at,
                ),
                AccessEvent(
                    id=3,
                    request_id="req-emp-b",
                    employee_id="EMP002",
                    gate_id="GATE_03",
                    direction="IN",
                    decision="GRANTED",
                    reason="OK",
                    previous_state="OUT",
                    current_state="IN",
                    latency_ms=9,
                    occurred_at=occurred_at,
                ),
            ]
        )
        db.commit()

    def _user(self, db: Session, username: str) -> UserAccount:
        user = db.scalar(select(UserAccount).where(UserAccount.username == username))
        assert user is not None
        return user


if __name__ == "__main__":
    unittest.main()
