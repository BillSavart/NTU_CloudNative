"""set database timezone to taipei

Revision ID: 20260526_0003
Revises: 20260526_0002
Create Date: 2026-05-26 22:00:00+08:00
"""
from collections.abc import Sequence

from alembic import op


revision: str = "20260526_0003"
down_revision: str | None = "20260526_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET TIME ZONE 'Asia/Taipei'")
    op.execute(
        """
        DO $$
        BEGIN
            EXECUTE format(
                'ALTER DATABASE %I SET timezone TO %L',
                current_database(),
                'Asia/Taipei'
            );
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            EXECUTE format(
                'ALTER DATABASE %I RESET timezone',
                current_database()
            );
        END $$;
        """
    )
