from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

from app.config import get_settings
from app.database import check_database

router = APIRouter()


@router.get("/health/")
def health(request: Request) -> JSONResponse:
    settings = get_settings()
    status_code = 200
    database = "ok"
    try:
        check_database()
    except Exception as exc:
        database = f"unavailable: {exc}"
        status_code = 503

    kafka_consumer = getattr(request.app.state, "access_event_consumer", None)
    redis_recovery_consumer = getattr(request.app.state, "redis_recovery_consumer", None)
    kafka_consumer_status = kafka_consumer.status.__dict__ if kafka_consumer is not None else None
    redis_recovery_status = (
        redis_recovery_consumer.status.__dict__ if redis_recovery_consumer is not None else None
    )

    return JSONResponse(
        status_code=status_code,
        content={
            "status": "ok" if status_code == 200 else "degraded",
            "service": settings.app_name,
            "environment": settings.app_env,
            "database": database,
            "kafkaConsumer": kafka_consumer_status,
            "redisRecovery": redis_recovery_status,
        },
    )
