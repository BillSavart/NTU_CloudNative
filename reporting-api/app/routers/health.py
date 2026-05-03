from fastapi import APIRouter

from app.config import get_settings

router = APIRouter()


@router.get("/health/")
def health() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "service": settings.app_name,
        "environment": settings.app_env,
    }
