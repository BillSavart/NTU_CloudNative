import asyncio
import logging
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import ResponseError

from app.config import Settings
from app.repositories import REQUIRED_EVENT_FIELDS, save_access_event

try:
    from app.observability import access_event_consumer_span
except ImportError:
    from contextlib import nullcontext

    def access_event_consumer_span(payload, source):
        return nullcontext()


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
                should_ack = await self._process_entry(redis, message_id, fields)
                if should_ack:
                    await redis.xack(
                        self.settings.redis_event_stream_key,
                        self.settings.redis_recovery_group,
                        message_id,
                    )
                processed_any = True
        return processed_any

    async def _process_entry(
        self, redis: Redis, message_id: str, fields: dict[str, Any]
    ) -> bool:
        """Back-fill a streamed event only if the Kafka consumer did not handle it.

        Kafka is the primary persister. We wait a grace period so it has a chance
        to persist the event and set its "persisted" marker, then skip the entry
        when the marker is present. In steady state (Kafka keeping up) every entry
        is skipped here, so recovery does no DB work; it only persists events
        Kafka has not handled within the window (Kafka down or badly lagging).

        Returns True when the entry may be XACK'd (skipped or persisted), False
        when a DB write failed and it must stay pending for retry.
        """
        await self._await_grace(message_id)
        request_id = str(fields.get("requestId", "")) if fields else ""
        if request_id and await self._already_persisted(redis, request_id):
            return True
        return await self._handle_message(fields)

    async def _await_grace(self, message_id: str) -> None:
        """Wait until the entry is at least ``grace`` seconds old (it may already
        be, e.g. a startup backlog), waking early if shutdown is requested."""
        grace = self.settings.redis_recovery_grace_seconds
        if grace <= 0:
            return
        wait = grace - self._entry_age_seconds(message_id)
        if wait > 0:
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stop_event.wait(), timeout=min(wait, grace))

    @staticmethod
    def _entry_age_seconds(message_id: str) -> float:
        """Age of a Redis stream id (``<ms>-<seq>``). Unparseable ids are treated
        as old so we never block on them."""
        try:
            created_ms = int(str(message_id).split("-", 1)[0])
        except (ValueError, AttributeError):
            return float("inf")
        return max(0.0, time.time() - created_ms / 1000.0)

    async def _already_persisted(self, redis: Redis, request_id: str) -> bool:
        key = self.settings.redis_persisted_marker_prefix + request_id
        try:
            return bool(await redis.exists(key))
        except Exception:
            # On a marker lookup failure, fall through and persist; the DB-level
            # request_id dedup still prevents a duplicate row.
            logger.warning("persisted-marker lookup failed for %s; will persist", request_id)
            return False

    async def _handle_message(self, fields: dict[str, Any]) -> bool:
        try:
            payload = self._payload_from_stream_fields(fields)
        except Exception as exc:
            self.status.failed += 1
            self.status.last_error = str(exc)
            logger.exception("failed to parse redis recovery event; acknowledging poison message")
            return True

        try:
            with access_event_consumer_span(payload, "redis-stream"):
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
