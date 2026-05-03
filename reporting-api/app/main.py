from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import health


settings = get_settings()

app = FastAPI(
    title="Reporting API",
    description="FastAPI skeleton for reporting and Kafka-to-DB work.",
    version="0.1.0",
    debug=settings.app_debug,
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


@app.get("/")
def root() -> dict[str, str]:
    return {"service": settings.app_name, "status": "ok"}
