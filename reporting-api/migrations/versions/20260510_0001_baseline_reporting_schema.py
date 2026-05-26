"""baseline reporting schema

Revision ID: 20260510_0001
Revises:
Create Date: 2026-05-10 00:01:00+00:00
"""
from collections.abc import Sequence

from alembic import op


revision: str = "20260510_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS departments (
            department_id VARCHAR(64) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            parent_department_id VARCHAR(64) REFERENCES departments(department_id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS employees (
            employee_id VARCHAR(64) PRIMARY KEY,
            display_name VARCHAR(255),
            department_id VARCHAR(64) REFERENCES departments(department_id),
            manager_employee_id VARCHAR(64) REFERENCES employees(employee_id),
            last_known_state VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
            last_seen_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT ck_employees_last_known_state
                CHECK (last_known_state in ('UNKNOWN', 'IN', 'OUT'))
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_accounts (
            user_id BIGSERIAL PRIMARY KEY,
            username VARCHAR(128) NOT NULL UNIQUE,
            password_hash VARCHAR(255),
            role VARCHAR(32) NOT NULL DEFAULT 'EMPLOYEE',
            employee_id VARCHAR(64) UNIQUE REFERENCES employees(employee_id),
            is_active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT ck_user_accounts_role
                CHECK (role in ('EMPLOYEE', 'MANAGER', 'EXECUTIVE', 'ADMIN'))
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_department_scopes (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
            department_id VARCHAR(64) NOT NULL REFERENCES departments(department_id),
            include_descendants BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_user_department_scopes_user_department
                UNIQUE (user_id, department_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS access_events (
            id BIGSERIAL PRIMARY KEY,
            request_id VARCHAR(128) NOT NULL,
            employee_id VARCHAR(64) NOT NULL REFERENCES employees(employee_id),
            gate_id VARCHAR(64) NOT NULL,
            direction VARCHAR(8) NOT NULL,
            decision VARCHAR(16) NOT NULL,
            reason VARCHAR(64) NOT NULL,
            previous_state VARCHAR(16) NOT NULL,
            current_state VARCHAR(16) NOT NULL,
            latency_ms INTEGER NOT NULL,
            remark TEXT,
            occurred_at TIMESTAMPTZ NOT NULL,
            consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_access_events_request_id UNIQUE (request_id),
            CONSTRAINT ck_access_events_direction CHECK (direction in ('IN', 'OUT')),
            CONSTRAINT ck_access_events_decision CHECK (decision in ('GRANTED', 'DENIED')),
            CONSTRAINT ck_access_events_previous_state
                CHECK (previous_state in ('UNKNOWN', 'IN', 'OUT')),
            CONSTRAINT ck_access_events_current_state
                CHECK (current_state in ('UNKNOWN', 'IN', 'OUT'))
        )
        """
    )

    op.execute("CREATE INDEX IF NOT EXISTS ix_employees_department_id ON employees (department_id)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_employees_manager_employee_id ON employees (manager_employee_id)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_user_department_scopes_user_id ON user_department_scopes (user_id)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_user_department_scopes_department_id "
        "ON user_department_scopes (department_id)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_access_events_employee_id ON access_events (employee_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_access_events_gate_id ON access_events (gate_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_access_events_occurred_at ON access_events (occurred_at)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_access_events_employee_occurred "
        "ON access_events (employee_id, occurred_at)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_access_events_decision_occurred "
        "ON access_events (decision, occurred_at)"
    )
    op.execute("ALTER TABLE access_events ADD COLUMN IF NOT EXISTS remark TEXT")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS access_events")
    op.execute("DROP TABLE IF EXISTS user_department_scopes")
    op.execute("DROP TABLE IF EXISTS user_accounts")
    op.execute("DROP TABLE IF EXISTS employees")
    op.execute("DROP TABLE IF EXISTS departments")
