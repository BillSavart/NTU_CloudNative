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
    cors_origins: str = ""

    postgres_db: str = "access_control"
    postgres_user: str = "root"
    postgres_password: str = "replace-with-a-strong-password"
    postgres_host: str = "127.0.0.1"
    postgres_port: int = 5432

    kafka_brokers: str = "127.0.0.1:19092,127.0.0.1:29092,127.0.0.1:39092"
    kafka_access_events_topic: str = "access-events"

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
