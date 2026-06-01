import logging
import time
from collections.abc import Iterable

from sqlalchemy import select

from app.config import get_settings
from app.database import SessionLocal
from app.migrations import run_migrations
from app.models import Department, UserAccount
from app.permissions import get_visible_department_ids
from app.repositories import REPORT_CENTER_PRECOMPUTE_PRESETS, refresh_report_center_snapshot


logger = logging.getLogger(__name__)
REPORT_CENTER_ROLES = {"ADMIN", "EXECUTIVE", "MANAGER"}


def snapshot_display_name(department_id: str | None, range_preset: str) -> str:
    department_part = (department_id or "ALL").strip() or "UNKNOWN_DEPARTMENT"
    range_part = range_preset.strip() or "UNKNOWN_RANGE"
    return f"{department_part}_{range_part}"


def run_migrations_with_retry(max_attempts: int = 30) -> None:
    for attempt in range(1, max_attempts + 1):
        try:
            logger.info("report precompute worker: running migrations")
            run_migrations()
            logger.info("report precompute worker: migrations finished")
            return
        except Exception:
            if attempt == max_attempts:
                raise
            logger.exception("database migration failed; retrying")
            time.sleep(2)


def active_report_user_ids(usernames: Iterable[str] | None = None) -> list[int]:
    username_filters = [username.strip() for username in usernames or [] if username.strip()]
    with SessionLocal() as db:
        query = (
            select(UserAccount.user_id)
            .where(
                UserAccount.is_active.is_(True),
                UserAccount.role.in_(REPORT_CENTER_ROLES),
            )
            .order_by(UserAccount.user_id)
        )
        if username_filters:
            query = query.where(UserAccount.username.in_(username_filters))
        return list(db.scalars(query).all())


def target_department_ids(user_id: int, department_limit: int) -> list[str]:
    with SessionLocal() as db:
        current_user = db.get(UserAccount, user_id)
        if current_user is None:
            return []

        visible_ids = get_visible_department_ids(db, current_user)
        if visible_ids is None:
            department_ids = list(db.scalars(select(Department.department_id).order_by(Department.department_id)).all())
        else:
            department_ids = visible_ids

    return department_ids[:department_limit]


def refresh_job(user_id: int, range_preset: str, department_id: str | None, limit: int) -> None:
    with SessionLocal() as db:
        current_user = db.get(UserAccount, user_id)
        if current_user is None:
            return
        refresh_report_center_snapshot(
            db,
            current_user=current_user,
            range_preset=range_preset,
            department_id=department_id,
            limit=limit,
        )
        snapshot_name = snapshot_display_name(department_id, range_preset)
        print(snapshot_name, flush=True)
        logger.info(
            "refreshed report snapshot name=%s user=%s preset=%s department=%s",
            snapshot_name,
            user_id,
            range_preset,
            department_id or "ALL",
        )


def refresh_all(
    presets: Iterable[str],
    limit: int,
    department_limit: int,
    usernames: Iterable[str] | None = None,
) -> None:
    username_filters = [username.strip() for username in usernames or [] if username.strip()]
    user_ids = active_report_user_ids(username_filters)
    if username_filters:
        logger.info("report precompute restricted to usernames=%s matched_users=%s", ",".join(username_filters), len(user_ids))
    for user_id in user_ids:
        departments = target_department_ids(user_id, department_limit)
        for range_preset in presets:
            if range_preset not in REPORT_CENTER_PRECOMPUTE_PRESETS:
                logger.warning("skipping unsupported report preset: %s", range_preset)
                continue
            for department_id in departments:
                try:
                    refresh_job(user_id, range_preset, department_id, limit)
                except Exception:
                    logger.exception(
                        "failed to refresh report snapshot user=%s preset=%s department=%s",
                        user_id,
                        range_preset,
                        department_id or "ALL",
                    )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    if not settings.report_center_precompute_enabled:
        logger.info("report precompute worker disabled")
        return

    run_migrations_with_retry()
    presets = settings.report_center_precompute_preset_list
    usernames = settings.report_center_precompute_username_list
    interval = max(30, settings.report_center_precompute_interval_seconds)
    limit = max(1, min(settings.report_center_precompute_limit, 1000))
    department_limit = max(0, settings.report_center_precompute_department_limit)

    while True:
        started = time.perf_counter()
        refresh_all(presets, limit, department_limit, usernames)
        elapsed = time.perf_counter() - started
        sleep_for = max(5, interval - elapsed)
        logger.info("report precompute cycle finished in %.2fs; sleeping %.2fs", elapsed, sleep_for)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
