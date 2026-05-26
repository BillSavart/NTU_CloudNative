import json
import unittest
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import AccessEvent, Base, Department, Employee, UserAccount, UserDepartmentScope
from app.repositories import (
    get_access_summary,
    get_dashboard,
    get_department_tree,
    parse_access_event,
    parse_event_timestamp,
    query_access_events,
    save_access_event_with_session,
)


TAIPEI = ZoneInfo("Asia/Taipei")


class RepositoryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.SessionLocal = sessionmaker(bind=engine)
        with self.SessionLocal() as db:
            self._seed(db)

    def test_parse_access_event_requires_expected_fields(self) -> None:
        payload = self._payload(request_id="req-parse")

        self.assertEqual(parse_access_event(json.dumps(payload).encode("utf-8")), payload)

        missing = dict(payload)
        missing.pop("requestId")
        with self.assertRaises(ValueError):
            parse_access_event(json.dumps(missing).encode("utf-8"))

    def test_parse_event_timestamp_supports_z_and_offsets(self) -> None:
        self.assertEqual(
            parse_event_timestamp("2026-05-20T09:04:50Z"),
            datetime(2026, 5, 20, 17, 4, 50, tzinfo=TAIPEI),
        )
        self.assertEqual(
            parse_event_timestamp("2026-05-20T17:04:50+08:00"),
            datetime(2026, 5, 20, 17, 4, 50, tzinfo=TAIPEI),
        )

    def test_save_access_event_inserts_employee_and_deduplicates_by_request_id(self) -> None:
        payload = self._payload(request_id="req-new", employee_id="NEW001", current_state="IN")

        with self.SessionLocal() as db:
            self.assertTrue(save_access_event_with_session(db, payload))
            self.assertFalse(save_access_event_with_session(db, payload))

            employee = db.get(Employee, "NEW001")
            self.assertIsNotNone(employee)
            assert employee is not None
            self.assertEqual(employee.last_known_state, "IN")
            self.assertEqual(
                employee.last_seen_at.replace(tzinfo=TAIPEI),
                datetime(2026, 5, 20, 17, 4, 50, tzinfo=TAIPEI),
            )
            self.assertEqual(
                db.scalar(select(AccessEvent).where(AccessEvent.request_id == "req-new")).employee_id,
                "NEW001",
            )

    def test_summary_and_event_filters(self) -> None:
        with self.SessionLocal() as db:
            manager = self._user(db, "manager")
            summary = get_access_summary(db, current_user=manager, department_id="FAB_A")
            filtered = query_access_events(
                db,
                current_user=manager,
                department_id="FAB_A",
                decision="DENIED",
                direction="IN",
                from_time=datetime(2026, 5, 20, 16, 0, tzinfo=TAIPEI),
                to_time=datetime(2026, 5, 20, 18, 0, tzinfo=TAIPEI),
                limit=1,
                offset=0,
            )

        self.assertEqual(summary["totalEvents"], 2)
        self.assertEqual(summary["grantedEvents"], 1)
        self.assertEqual(summary["deniedEvents"], 1)
        self.assertEqual(summary["knownEmployees"], 2)
        self.assertEqual(summary["employeesInside"], 1)
        self.assertEqual(summary["employeesOutside"], 1)
        self.assertEqual(filtered["total"], 1)
        self.assertEqual(filtered["items"][0]["employeeId"], "EMP001")
        self.assertEqual(filtered["items"][0]["decision"], "DENIED")

    def test_summary_counts_unknown_employees_as_outside(self) -> None:
        with self.SessionLocal() as db:
            db.add(
                Employee(
                    employee_id="EMP003",
                    display_name="Unknown State Operator",
                    department_id="FAB_A",
                    last_known_state="UNKNOWN",
                )
            )
            db.commit()

            summary = get_access_summary(db)

        self.assertEqual(summary["knownEmployees"], 4)
        self.assertEqual(summary["employeesInside"], 2)
        self.assertEqual(summary["employeesOutside"], 2)

    def test_department_tree_is_scoped_by_role(self) -> None:
        with self.SessionLocal() as db:
            manager = self._user(db, "manager")
            tree = get_department_tree(db, current_user=manager)

        self.assertEqual([department["departmentId"] for department in tree], ["FAB_A"])
        self.assertEqual(tree[0]["children"][0]["departmentId"], "OPS_A")

    def test_dashboard_combines_summary_anomalies_and_timeseries(self) -> None:
        with self.SessionLocal() as db:
            with patch("app.repositories.get_timeseries", return_value=[{"bucket": "demo"}]):
                dashboard = get_dashboard(db)

        self.assertEqual(dashboard["totalEvents"], 3)
        self.assertEqual(len(dashboard["anomalies"]), 1)
        self.assertEqual(dashboard["timeseries"], [{"bucket": "demo"}])

    def _payload(
        self,
        request_id: str,
        employee_id: str = "EMP001",
        current_state: str = "IN",
    ) -> dict[str, object]:
        return {
            "requestId": request_id,
            "employeeId": employee_id,
            "gateId": "GATE_01",
            "direction": "IN",
            "decision": "GRANTED",
            "reason": "ACCESS_ALLOWED",
            "previousState": "OUT",
            "currentState": current_state,
            "latencyMs": 5,
            "timestamp": "2026-05-20T09:04:50Z",
        }

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
                Employee(employee_id="MGR001", display_name="Manager", department_id="FAB_A", last_known_state="OUT"),
                Employee(employee_id="EMP001", display_name="Operator", department_id="OPS_A", last_known_state="IN"),
                Employee(employee_id="EMP002", display_name="Other", department_id="FAB_B", last_known_state="IN"),
            ]
        )
        db.add_all(
            [
                UserAccount(user_id=1, username="admin", role="ADMIN", is_active=True),
                UserAccount(user_id=2, username="manager", role="MANAGER", employee_id="MGR001", is_active=True),
            ]
        )
        db.add(UserDepartmentScope(user_id=2, department_id="FAB_A", include_descendants=True))
        base_time = datetime(2026, 5, 20, 17, 0, tzinfo=TAIPEI)
        db.add_all(
            [
                AccessEvent(
                    request_id="req-granted",
                    employee_id="MGR001",
                    gate_id="GATE_01",
                    direction="OUT",
                    decision="GRANTED",
                    reason="ACCESS_ALLOWED",
                    previous_state="IN",
                    current_state="OUT",
                    latency_ms=5,
                    occurred_at=base_time,
                ),
                AccessEvent(
                    request_id="req-denied",
                    employee_id="EMP001",
                    gate_id="GATE_02",
                    direction="IN",
                    decision="DENIED",
                    reason="ANTI_PASSBACK_VIOLATION",
                    previous_state="IN",
                    current_state="IN",
                    latency_ms=7,
                    occurred_at=base_time + timedelta(minutes=1),
                ),
                AccessEvent(
                    request_id="req-other",
                    employee_id="EMP002",
                    gate_id="GATE_03",
                    direction="IN",
                    decision="GRANTED",
                    reason="ACCESS_ALLOWED",
                    previous_state="OUT",
                    current_state="IN",
                    latency_ms=9,
                    occurred_at=base_time,
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
