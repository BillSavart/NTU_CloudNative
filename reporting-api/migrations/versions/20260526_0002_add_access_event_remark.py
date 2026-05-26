"""add access event remark

Revision ID: 20260526_0002
Revises: 20260510_0001
Create Date: 2026-05-26 20:45:00+08:00
"""
from collections.abc import Sequence

from alembic import op


revision: str = "20260526_0002"
down_revision: str | None = "20260510_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE access_events ADD COLUMN IF NOT EXISTS remark TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE access_events DROP COLUMN IF EXISTS remark")
