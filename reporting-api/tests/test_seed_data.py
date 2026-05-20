import unittest

from app.seed import (
    DEMO_DEPARTMENTS,
    DEMO_EMPLOYEES,
    DEPARTMENT_PARENT_IDS,
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

        self.assertEqual([employee["employee_id"] for employee in top_level], ["EXEC001"])

        for employee in DEMO_EMPLOYEES:
            if employee["employee_id"] == "EXEC001":
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


def department_is_same_or_descendant(department_id: str, manager_department_id: str) -> bool:
    current = department_id
    while current is not None:
        if current == manager_department_id:
            return True
        current = DEPARTMENT_PARENT_IDS[current]
    return False


if __name__ == "__main__":
    unittest.main()
