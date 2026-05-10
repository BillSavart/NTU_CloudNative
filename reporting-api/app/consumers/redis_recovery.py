import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import ResponseError

from app.config import Settings
from app.repositories import REQUIRED_EVENT_FIELDS, save_access_event


logger = logging.getLogger(__name__)


@dataclass
class RedisRecoveryStatus:
    enabled: bool
    running: bool
    stream: str
    group: str
    consumer: str
    processed: int = 0
    inserted: int = 0
    duplicates: int = 0
    failed: int = 0
    last_error: str | None = None


class RedisRecoveryConsumerService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.status = RedisRecoveryStatus(
            enabled=settings.redis_recovery_enabled,
            running=False,
            stream=settings.redis_event_stream_key,
            group=settings.redis_recovery_group,
            consumer=settings.redis_recovery_consumer_name,
        )
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        if not self.settings.redis_recovery_enabled or self._task is not None:
            return
        self._task = asyncio.create_task(self._run(), name="redis-recovery-consumer")

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        retry_seconds = 2
        while not self._stop_event.is_set():
            try:
                await self._consume_forever()
                retry_seconds = 2
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.status.running = False
                self.status.last_error = str(exc)
                logger.exception("redis recovery consumer crashed")
                await asyncio.sleep(retry_seconds)
                retry_seconds = min(retry_seconds * 2, 30)

    async def _consume_forever(self) -> None:
        redis = Redis.from_url(self.settings.redis_url, decode_responses=True)
        try:
            await self._ensure_group(redis)
            self.status.running = True
            self.status.last_error = None
            logger.info(
                "redis recovery consumer started stream=%s group=%s consumer=%s",
                self.settings.redis_event_stream_key,
                self.settings.redis_recovery_group,
                self.settings.redis_recovery_consumer_name,
            )

            await self._drain_pending(redis)
            while not self._stop_event.is_set():
                await self._read_and_process(redis, ">")
        finally:
            self.status.running = False
            await redis.aclose()
            logger.info("redis recovery consumer stopped")

    async def _ensure_group(self, redis: Redis) -> None:
        try:
            await redis.xgroup_create(
                self.settings.redis_event_stream_key,
                self.settings.redis_recovery_group,
                id="0",
                mkstream=True,
            )
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def _drain_pending(self, redis: Redis) -> None:
        while not self._stop_event.is_set():
            processed = await self._read_and_process(redis, "0", block_ms=1)
            if not processed:
                return

    async def _read_and_process(self, redis: Redis, stream_id: str, block_ms: int | None = None) -> bool:
        streams = await redis.xreadgroup(
            groupname=self.settings.redis_recovery_group,
            consumername=self.settings.redis_recovery_consumer_name,
            streams={self.settings.redis_event_stream_key: stream_id},
            count=self.settings.redis_recovery_batch_size,
            block=self.settings.redis_recovery_block_ms if block_ms is None else block_ms,
        )
        if not streams:
            return False

        processed_any = False
        for _, messages in streams:
            for message_id, fields in messages:
                should_ack = await self._handle_message(fields)
                if should_ack:
                    await redis.xack(
                        self.settings.redis_event_stream_key,
                        self.settings.redis_recovery_group,
                        message_id,
                    )
                processed_any = True
        return processed_any

    async def _handle_message(self, fields: dict[str, Any]) -> bool:
        try:
            payload = self._payload_from_stream_fields(fields)
        except Exception as exc:
            self.status.failed += 1
            self.status.last_error = str(exc)
            logger.exception("failed to parse redis recovery event; acknowledging poison message")
            return True

        try:
            inserted = await asyncio.to_thread(save_access_event, payload)
            self.status.processed += 1
            if inserted:
                self.status.inserted += 1
            else:
                self.status.duplicates += 1
            return True
        except Exception as exc:
            self.status.failed += 1
            self.status.last_error = str(exc)
            logger.exception("failed to persist redis recovery event")
            return False

    def _payload_from_stream_fields(self, fields: dict[str, Any]) -> dict[str, Any]:
        payload = {str(key): value for key, value in fields.items()}
        missing = REQUIRED_EVENT_FIELDS - payload.keys()
        if missing:
            raise ValueError(f"redis recovery event missing fields: {sorted(missing)}")
        return payload
