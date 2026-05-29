"""Shared test helpers for choosing the backend database engine.

By default tests run against an in-memory SQLite database, which is fast but
silently skips PostgreSQL-only SQL (``FILTER (WHERE ...)``, ``::date`` casts,
``to_char``, ``WITH ... MATERIALIZED``). Setting ``TEST_DATABASE_URL`` to a
PostgreSQL DSN makes the same test suite execute against a real PostgreSQL,
exercising those production code paths.

Example::

    TEST_DATABASE_URL=postgresql+psycopg://root:pw@localhost:5432/access_control_test \\
        python -m unittest discover -s tests
"""
from __future__ import annotations

import os
import unittest

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine

from app.models import Base


TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", "").strip()

# Mirrors migration 20260526_0003: the production database runs in Asia/Taipei,
# which is what the attendance ``::date`` / ``::time`` casts rely on. We apply it
# at the session level so the dual-mode tests match production semantics.
TEST_TIMEZONE = "Asia/Taipei"


def using_postgres() -> bool:
    return TEST_DATABASE_URL.startswith("postgresql")


def create_test_engine() -> Engine:
    """Return a fresh engine with an empty schema for a single test case."""
    if using_postgres():
        engine = create_engine(TEST_DATABASE_URL, future=True)

        @event.listens_for(engine, "connect")
        def _set_session_timezone(dbapi_connection, _connection_record):  # noqa: ANN001
            cursor = dbapi_connection.cursor()
            try:
                cursor.execute(f"SET TIME ZONE '{TEST_TIMEZONE}'")
            finally:
                cursor.close()

        # Drop first so each test starts from a clean, isolated schema even when
        # several test cases share the same physical database.
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        return engine

    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return engine


requires_postgres = unittest.skipUnless(
    using_postgres(),
    "set TEST_DATABASE_URL to a PostgreSQL DSN to exercise PostgreSQL-only paths",
)


def database_timezone(engine: Engine) -> str:
    with engine.connect() as conn:
        return conn.execute(text("SHOW timezone")).scalar_one()
