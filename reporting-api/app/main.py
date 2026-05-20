import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.consumers.access_events import AccessEventConsumerService
from app.consumers.redis_recovery import RedisRecoveryConsumerService
from app.migrations import run_migrations
from app.routers import auth, health, reports


settings = get_settings()
logger = logging.getLogger(__name__)


async def run_migrations_with_retry(max_attempts: int = 30) -> None:
    for attempt in range(1, max_attempts + 1):
        try:
            print("reporting-api startup: running migrations", flush=True)
            run_migrations()
            print("reporting-api startup: migrations finished", flush=True)
            return
        except Exception:
            if attempt == max_attempts:
                raise
            logger.exception("database migration failed; retrying")
            await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    import os
    print("PID:", os.getpid(), flush=True)
    
    await run_migrations_with_retry()
    kafka_consumer = AccessEventConsumerService(settings)
    redis_recovery_consumer = RedisRecoveryConsumerService(settings)
    app.state.access_event_consumer = kafka_consumer
    app.state.redis_recovery_consumer = redis_recovery_consumer
    print("reporting-api startup: starting background consumers", flush=True)
    kafka_consumer.start()
    redis_recovery_consumer.start()
    print("reporting-api startup: background consumers started", flush=True)
    try:
        yield
    finally:
        await kafka_consumer.stop()
        await redis_recovery_consumer.stop()


app = FastAPI(
    title="Reporting API",
    description="Reporting API for Kafka-to-PostgreSQL access events.",
    version="0.1.0",
    debug=settings.app_debug,
    lifespan=lifespan,
)

if settings.cors_origin_list:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(auth.router, prefix="/api", tags=["auth"])
app.include_router(reports.router, prefix="/api", tags=["reports"])


@app.get("/")
def root() -> dict[str, str]:
    return {"service": settings.app_name, "status": "ok"}
