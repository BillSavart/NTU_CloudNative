"""Add password reset fields to user accounts."""

from alembic import op


revision = "20260527_0004"
down_revision = "20260526_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS email VARCHAR(255)")
    op.execute("ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS password_reset_token_hash VARCHAR(255)")
    op.execute("ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ")
    op.execute("ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS password_reset_used_at TIMESTAMPTZ")
    op.execute("CREATE INDEX IF NOT EXISTS ix_user_accounts_email ON user_accounts (email)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_user_accounts_email")
    op.execute("ALTER TABLE user_accounts DROP COLUMN IF EXISTS password_reset_used_at")
    op.execute("ALTER TABLE user_accounts DROP COLUMN IF EXISTS password_reset_expires_at")
    op.execute("ALTER TABLE user_accounts DROP COLUMN IF EXISTS password_reset_token_hash")
    op.execute("ALTER TABLE user_accounts DROP COLUMN IF EXISTS email")
