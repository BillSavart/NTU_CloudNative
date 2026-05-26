from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    connect_args={"options": "-c timezone=Asia/Taipei"},
)


@event.listens_for(engine, "connect")
def set_taipei_timezone(dbapi_connection, connection_record) -> None:
    with dbapi_connection.cursor() as cursor:
        cursor.execute("SET TIME ZONE 'Asia/Taipei'")


SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_database() -> bool:
    with engine.connect() as connection:
        connection.execute(text("select 1"))
    return True
