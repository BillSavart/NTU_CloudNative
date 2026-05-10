from fastapi import APIRouter, Query

from app.repositories import get_access_summary, list_recent_events

router = APIRouter()


@router.get("/reports/access/summary")
def access_summary() -> dict[str, int]:
    return get_access_summary()


@router.get("/reports/access/events")
def recent_access_events(limit: int = Query(default=50, ge=1, le=200)) -> dict[str, object]:
    events = list_recent_events(limit)
    return {"events": events}
