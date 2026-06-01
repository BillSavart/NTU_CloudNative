"""Add report center snapshots."""

from alembic import op


revision = "20260601_0006"
down_revision = "20260527_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS report_center_snapshots (
            id BIGSERIAL PRIMARY KEY,
            cache_user_key VARCHAR(128) NOT NULL,
            user_id BIGINT REFERENCES user_accounts(user_id) ON DELETE CASCADE,
            range_preset VARCHAR(32) NOT NULL,
            target_type VARCHAR(32) NOT NULL DEFAULT 'department',
            target_id VARCHAR(128) NOT NULL,
            scope_hash VARCHAR(64) NOT NULL,
            scope_key TEXT NOT NULL,
            period_from TIMESTAMPTZ NOT NULL,
            period_to TIMESTAMPTZ NOT NULL,
            preview_limit INTEGER NOT NULL DEFAULT 500,
            payload JSONB NOT NULL,
            generated_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_report_center_snapshots_lookup
                UNIQUE (
                    cache_user_key,
                    range_preset,
                    target_type,
                    target_id,
                    scope_hash,
                    period_from,
                    period_to,
                    preview_limit
                )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_report_center_snapshots_cache_user_key
        ON report_center_snapshots (cache_user_key)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_report_center_snapshots_user_id
        ON report_center_snapshots (user_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_report_center_snapshots_lookup
        ON report_center_snapshots (
            cache_user_key,
            range_preset,
            target_type,
            target_id,
            scope_hash
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_report_center_snapshots_lookup")
    op.execute("DROP INDEX IF EXISTS ix_report_center_snapshots_user_id")
    op.execute("DROP INDEX IF EXISTS ix_report_center_snapshots_cache_user_key")
    op.execute("DROP TABLE IF EXISTS report_center_snapshots")
