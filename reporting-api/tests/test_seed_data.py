import unittest

from app.seed import (
    DEMO_DEPARTMENTS,
    DEMO_EMPLOYEES,
    DEPARTMENT_PARENT_IDS,
    FAB_COUNT,
    FAB_UNITS,
    manager_for_department,
)


class SeedDataTestCase(unittest.TestCase):
    def test_demo_employee_managers_form_valid_department_tree(self) -> None:
        employees = {employee["employee_id"]: employee for employee in DEMO_EMPLOYEES}
        top_level = [
            employee
            for employee in DEMO_EMPLOYEES
            if employee["manager_employee_id"] is None
        ]

        self.assertEqual([employee["employee_id"] for employee in top_level], ["100000"])

        for employee in DEMO_EMPLOYEES:
            if employee["employee_id"] == "100000":
                continue

            manager_id = employee["manager_employee_id"]
            self.assertIsNotNone(manager_id, employee["employee_id"])
            self.assertIn(manager_id, employees, employee["employee_id"])
            manager = employees[manager_id]
            self.assertTrue(
                department_is_same_or_descendant(
                    employee["department_id"],
                    manager["department_id"],
                ),
                f"{employee['employee_id']} department must be under {manager_id}",
            )

    def test_generated_demo_department_managers_are_valid(self) -> None:
        employees = {employee["employee_id"]: employee for employee in DEMO_EMPLOYEES}

        for department_id in DEMO_DEPARTMENTS:
            manager_id = manager_for_department(department_id)
            self.assertIn(manager_id, employees)
            self.assertTrue(
                department_is_same_or_descendant(
                    department_id,
                    employees[manager_id]["department_id"],
                ),
                f"{department_id} generated employees must report to a valid manager",
            )

    def test_company_structure_matches_requested_fabs_and_units(self) -> None:
        self.assertEqual(DEPARTMENT_PARENT_IDS["TSMC"], None)
        for fab_no in range(1, FAB_COUNT + 1):
            self.assertEqual(DEPARTMENT_PARENT_IDS[f"fab_{fab_no}"], "TSMC")
            for unit in FAB_UNITS:
                self.assertEqual(DEPARTMENT_PARENT_IDS[f"{unit}_{fab_no}"], f"fab_{fab_no}")

        employees = {employee["employee_id"]: employee for employee in DEMO_EMPLOYEES}
        self.assertEqual(employees["100000"]["display_name"], "CC Wei")
        self.assertEqual(employees["100001"]["display_name"], "Bill Wang")
        self.assertEqual(employees["100002"]["display_name"], "Ichigo")
        self.assertEqual(employees["100003"]["display_name"], "Steven Lai")
        self.assertEqual(employees["100004"]["display_name"], "Amy Huang")
        self.assertEqual(employees["100005"]["display_name"], "High Ray")
        self.assertEqual(employees["110001"]["display_name"], "Ethan Chen")
        self.assertEqual(employees["120001"]["display_name"], "Lily Wang")
        self.assertEqual(employees["130001"]["display_name"], "Marcus Lin")
        self.assertEqual(employees["140001"]["display_name"], "Nina Huang")
        self.assertEqual(employees["199001"]["display_name"], "YP Hung")
        self.assertEqual(employees["199001"]["department_id"], "EE_1")
        self.assertEqual(employees["199001"]["manager_employee_id"], "140001")


def department_is_same_or_descendant(department_id: str, manager_department_id: str) -> bool:
    current = department_id
    while current is not None:
        if current == manager_department_id:
            return True
        current = DEPARTMENT_PARENT_IDS[current]
    return False


if __name__ == "__main__":
    unittest.main()
