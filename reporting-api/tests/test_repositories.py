import json
import unittest
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models import AccessEvent, Department, Employee, UserAccount, UserDepartmentScope
from tests.support import create_test_engine
from app.repositories import (
    get_access_summary,
    get_dashboard,
    get_dashboard_operational_metrics,
    get_compliance_anomalies,
    get_department_analytics,
    get_department_tree,
    get_report_center,
    parse_access_event,
    parse_event_timestamp,
    query_access_events,
    save_access_event_with_session,
)


TAIPEI = ZoneInfo("Asia/Taipei")


class RepositoryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        engine = create_test_engine()
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

            summary = get_access_summary(db, self._user(db, "admin"))

        self.assertEqual(summary["knownEmployees"], 4)
        self.assertEqual(summary["employeesInside"], 2)
        self.assertEqual(summary["employeesOutside"], 2)

    def test_department_tree_is_scoped_by_role(self) -> None:
        with self.SessionLocal() as db:
            manager = self._user(db, "manager")
            tree = get_department_tree(db, current_user=manager)

        self.assertEqual([department["departmentId"] for department in tree], ["FAB_A"])
        self.assertEqual(tree[0]["children"][0]["departmentId"], "OPS_A")

    def test_department_analytics_counts_displayed_child_departments(self) -> None:
        with self.SessionLocal() as db:
            manager = self._user(db, "manager")
            analytics = get_department_analytics(db, current_user=manager)

        self.assertEqual(analytics["visibleDepartmentCount"], len(analytics["departments"]))
        self.assertEqual(analytics["visibleDepartmentCount"], 1)
        self.assertEqual(analytics["departments"][0]["departmentId"], "OPS_A")

    def test_dashboard_combines_summary_anomalies_and_timeseries(self) -> None:
        with self.SessionLocal() as db:
            with patch("app.repositories.get_timeseries", return_value=[{"bucket": "demo"}]):
                dashboard = get_dashboard(db, self._user(db, "admin"))

        self.assertEqual(dashboard["totalEvents"], 3)
        self.assertEqual(dashboard["hrMetrics"]["expectedToday"], 3)
        self.assertEqual(dashboard["hrMetrics"]["attendedToday"], 2)
        self.assertEqual(dashboard["hrMetrics"]["attendanceRate"], 66.7)
        self.assertEqual(dashboard["securityMetrics"]["antiPassbackViolations"], 1)
        self.assertEqual(dashboard["trafficMetrics"]["peakGateHour"]["gateId"], "GATE_01")
        self.assertIsInstance(dashboard["generationLatencyMs"], float)
        self.assertEqual(len(dashboard["anomalies"]), 1)
        self.assertEqual(dashboard["timeseries"], [{"bucket": "demo"}])

    def test_dashboard_operational_metrics_flags_hr_security_and_peak_gate(self) -> None:
        with self.SessionLocal() as db:
            db.add_all(
                [
                    AccessEvent(
                        request_id="req-emp-late-in-1",
                        employee_id="EMP001",
                        gate_id="GATE_04",
                        direction="IN",
                        decision="GRANTED",
                        reason="ACCESS_ALLOWED",
                        previous_state="OUT",
                        current_state="IN",
                        latency_ms=5,
                        occurred_at=datetime(2026, 5, 21, 9, 0, tzinfo=TAIPEI),
                    ),
                    AccessEvent(
                        request_id="req-emp-late-out-1",
                        employee_id="EMP001",
                        gate_id="GATE_04",
                        direction="OUT",
                        decision="GRANTED",
                        reason="ACCESS_ALLOWED",
                        previous_state="IN",
                        current_state="OUT",
                        latency_ms=5,
                        occurred_at=datetime(2026, 5, 21, 22, 0, tzinfo=TAIPEI),
                    ),
                    AccessEvent(
                        request_id="req-emp-late-in-2",
                        employee_id="EMP001",
                        gate_id="GATE_04",
                        direction="IN",
                        decision="GRANTED",
                        reason="ACCESS_ALLOWED",
                        previous_state="OUT",
                        current_state="IN",
                        latency_ms=5,
                        occurred_at=datetime(2026, 5, 22, 9, 20, tzinfo=TAIPEI),
                    ),
                    AccessEvent(
                        request_id="req-emp-late-out-2",
                        employee_id="EMP001",
                        gate_id="GATE_04",
                        direction="OUT",
                        decision="GRANTED",
                        reason="ACCESS_ALLOWED",
                        previous_state="IN",
                        current_state="OUT",
                        latency_ms=5,
                        occurred_at=datetime(2026, 5, 22, 22, 20, tzinfo=TAIPEI),
                    ),
                    AccessEvent(
                        request_id="req-emp-denied-2",
                        employee_id="EMP001",
                        gate_id="GATE_02",
                        direction="IN",
                        decision="DENIED",
                        reason="ANTI_PASSBACK_VIOLATION",
                        previous_state="IN",
                        current_state="IN",
                        latency_ms=5,
                        occurred_at=datetime(2026, 5, 22, 12, 0, tzinfo=TAIPEI),
                    ),
                ]
            )
            db.commit()

            metrics = get_dashboard_operational_metrics(
                db,
                self._user(db, "admin"),
                from_time=datetime(2026, 5, 22, 0, 0, tzinfo=TAIPEI),
                to_time=datetime(2026, 5, 22, 23, 59, tzinfo=TAIPEI),
            )

        self.assertEqual(metrics["hrMetrics"]["attendedToday"], 2)
        self.assertEqual(metrics["hrMetrics"]["topLateDepartment"], {"key": "OPS_A", "count": 1})
        self.assertEqual(metrics["hrMetrics"]["overtimeAlertCount"], 2)
        self.assertEqual(metrics["hrMetrics"]["overtimeAlerts"][0]["employeeId"], "EMP001")
        self.assertEqual(metrics["hrMetrics"]["overtimeAlerts"][0]["workHours"], 13.0)
        self.assertEqual(metrics["hrMetrics"]["overtimeAlerts"][0]["date"], "2026-05-22")
        self.assertEqual(metrics["securityMetrics"]["antiPassbackViolations"], 1)
        self.assertEqual(metrics["securityMetrics"]["topViolationPeople"][0]["employeeId"], "EMP001")
        self.assertEqual(metrics["trafficMetrics"]["peakGateHour"], {"gateId": "GATE_04", "hour": 9, "count": 1})

    def test_compliance_anomalies_can_filter_late_arrivals(self) -> None:
        with self.SessionLocal() as db:
            db.add(
                AccessEvent(
                    request_id="req-late-arrival",
                    employee_id="EMP001",
                    gate_id="GATE_04_A",
                    direction="IN",
                    decision="GRANTED",
                    reason="ACCESS_ALLOWED",
                    previous_state="OUT",
                    current_state="IN",
                    latency_ms=5,
                    occurred_at=datetime(2026, 5, 22, 9, 20, tzinfo=TAIPEI),
                )
            )
            db.commit()

            # Use a fixed date + explicit window. The previous datetime.now()
            # made this flaky: get_compliance_anomalies defaults to_time=now, so
            # when CI ran before 09:05 local time the "today 09:05" event was in
            # the future and got filtered out (total=0).
            result = get_compliance_anomalies(
                db,
                self._user(db, "admin"),
                anomaly_type="late_arrival",
                from_time=datetime(2026, 5, 22, 0, 0, tzinfo=TAIPEI),
                to_time=datetime(2026, 5, 22, 23, 59, tzinfo=TAIPEI),
            )

        self.assertGreaterEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["type"], "late_arrival")
        self.assertEqual(result["items"][0]["typeLabel"], "遲到人員")

    def test_report_center_returns_server_side_metrics_and_latency(self) -> None:
        with self.SessionLocal() as db:
            manager = self._user(db, "manager")
            report = get_report_center(
                db,
                current_user=manager,
                from_time=datetime(2026, 5, 20, 16, 0, tzinfo=TAIPEI),
                to_time=datetime(2026, 5, 20, 18, 0, tzinfo=TAIPEI),
                limit=2,
            )

        self.assertEqual(report["metrics"]["totalEvents"], 2)
        self.assertEqual(report["metrics"]["grantedEvents"], 1)
        self.assertEqual(report["metrics"]["deniedEvents"], 1)
        self.assertEqual(report["metrics"]["inEvents"], 1)
        self.assertEqual(report["metrics"]["outEvents"], 1)
        self.assertEqual(report["metrics"]["avgLatencyMs"], 6.0)
        self.assertEqual(report["metrics"]["deniedRate"], 50.0)
        self.assertEqual(report["topDepartments"][0], {"departmentId": "OPS_A", "count": 1})
        self.assertNotIn("FAB_A", {row["departmentId"] for row in report["topDepartments"]})
        self.assertEqual(report["hourlyActivity"], [{"hour": "17", "count": 2, "inCount": 1, "outCount": 1}])
        self.assertEqual(len(report["events"]), 2)
        self.assertIsInstance(report["generationLatencyMs"], float)

    def test_report_center_keeps_leaf_manager_department_distribution(self) -> None:
        with self.SessionLocal() as db:
            db.add(UserAccount(user_id=3, username="ops_manager", role="MANAGER", employee_id="EMP001", is_active=True))
            db.add(UserDepartmentScope(user_id=3, department_id="OPS_A", include_descendants=True))
            db.commit()
            manager = self._user(db, "ops_manager")
            report = get_report_center(
                db,
                current_user=manager,
                from_time=datetime(2026, 5, 20, 16, 0, tzinfo=TAIPEI),
                to_time=datetime(2026, 5, 20, 18, 0, tzinfo=TAIPEI),
                limit=2,
            )

        self.assertEqual(report["topDepartments"], [{"departmentId": "OPS_A", "count": 1}])

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
