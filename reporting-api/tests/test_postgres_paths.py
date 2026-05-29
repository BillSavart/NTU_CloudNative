"""Explicit PostgreSQL-only coverage.

These tests are skipped under the default SQLite backend and only run when
``TEST_DATABASE_URL`` points at a real PostgreSQL instance. They guard the
production-only behaviour that SQLite silently tolerates:

* the session timezone is ``Asia/Taipei`` (migration 20260526_0003), which the
  attendance ``::date`` / ``::time`` casts depend on; and
* PostgreSQL-only SQL constructs (``FILTER (WHERE ...)``, ``::date`` casts,
  ``to_char``, ``WITH ... MATERIALIZED``) actually parse and execute.
"""
from __future__ import annotations

import unittest

from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from tests.support import create_test_engine, database_timezone, requires_postgres


@requires_postgres
class PostgresPathTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_test_engine()
        self.SessionLocal = sessionmaker(bind=self.engine)

    def test_session_timezone_is_taipei(self) -> None:
        self.assertEqual(database_timezone(self.engine), "Asia/Taipei")

    def test_filter_clause_executes(self) -> None:
        with self.SessionLocal() as db:
            value = db.execute(
                text(
                    "SELECT count(*) FILTER (WHERE n > 1) "
                    "FROM (VALUES (1), (2), (3)) AS t(n)"
                )
            ).scalar_one()
        self.assertEqual(value, 2)

    def test_date_cast_and_to_char_execute(self) -> None:
        with self.SessionLocal() as db:
            day = db.execute(
                text("SELECT to_char(timestamptz '2026-05-20T09:04:50Z'::date, 'YYYY-MM-DD')")
            ).scalar_one()
        # 09:04 UTC is 17:04 Asia/Taipei, still the same calendar day.
        self.assertEqual(day, "2026-05-20")

    def test_materialized_cte_executes(self) -> None:
        with self.SessionLocal() as db:
            total = db.execute(
                text(
                    "WITH nums AS MATERIALIZED ("
                    "  SELECT n FROM generate_series(1, 5) AS g(n)"
                    ") SELECT sum(n) FROM nums"
                )
            ).scalar_one()
        self.assertEqual(total, 15)


if __name__ == "__main__":
    unittest.main()
