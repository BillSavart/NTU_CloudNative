"""Populate demo email addresses for existing user accounts."""

from alembic import op


revision = "20260527_0005"
down_revision = "20260527_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE user_accounts
        SET email = username || '@demo.local'
        WHERE email IS NULL
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE user_accounts
        SET email = NULL
        WHERE email = username || '@demo.local'
        """
    )
