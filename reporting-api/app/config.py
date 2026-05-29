from datetime import time
from functools import lru_cache
from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "reporting-api"
    app_env: str = "local"
    app_debug: bool = True
    app_secret_key: str = "replace-with-a-long-random-secret"
    app_cookie_secure: bool = False
    cors_origins: str = ""
    demo_seed_password: str = ""

    postgres_db: str = "access_control"
    postgres_user: str = "root"
    postgres_password: str = "replace-with-a-strong-password"
    postgres_host: str = "127.0.0.1"
    postgres_port: int = 5432

    kafka_brokers: str = "127.0.0.1:19092,127.0.0.1:29092,127.0.0.1:39092"
    kafka_access_events_topic: str = "access-events"
    kafka_consumer_enabled: bool = True
    kafka_consumer_group_id: str = "reporting-api"
    kafka_auto_offset_reset: str = "earliest"
    # Message-level retry backoff when persistence fails (e.g. DB outage).
    # The consumer keeps its Kafka connection and retries the same message
    # instead of crashing and reconnecting.
    kafka_consume_retry_initial_seconds: float = 1.0
    kafka_consume_retry_max_seconds: float = 30.0

    redis_addr: str = "127.0.0.1:6379"
    redis_password: str = ""
    redis_db: int = 0
    redis_event_stream_key: str = "access:events"
    redis_recovery_enabled: bool = True
    redis_recovery_group: str = "reporting-api"
    redis_recovery_consumer_name: str = "reporting-api-1"
    redis_recovery_block_ms: int = 5000
    redis_recovery_batch_size: int = 100

    # --- Attendance / access business rules (single source of truth) ---
    # SQL LIKE pattern identifying "main entrance" gates used for attendance.
    attendance_main_gate_pattern: str = "%_A"
    # Daily late-arrival cutoff. First IN after this time counts as late.
    attendance_late_threshold: str = "08:30:00"
    # Worked hours above this threshold count as overtime.
    attendance_overtime_hours: float = 12.0

    @computed_field
    @property
    def database_url(self) -> str:
        return (
            "postgresql+psycopg://"
            f"{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @computed_field
    @property
    def kafka_broker_list(self) -> list[str]:
        return [broker.strip() for broker in self.kafka_brokers.split(",") if broker.strip()]

    @computed_field
    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @computed_field
    @property
    def redis_url(self) -> str:
        auth = f":{self.redis_password}@" if self.redis_password else ""
        return f"redis://{auth}{self.redis_addr}/{self.redis_db}"

    @computed_field
    @property
    def attendance_late_threshold_time(self) -> time:
        return time.fromisoformat(self.attendance_late_threshold)


@lru_cache
def get_settings() -> Settings:
    return Settings()
