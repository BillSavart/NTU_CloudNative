import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass

from aiokafka import AIOKafkaConsumer
from redis.asyncio import Redis

from app.config import Settings
from app.repositories import parse_access_event, save_access_event

try:
    from app.observability import access_event_consumer_span
except ImportError:
    from contextlib import nullcontext

    def access_event_consumer_span(payload, source):
        return nullcontext()


logger = logging.getLogger(__name__)


@dataclass
class ConsumerStatus:
    enabled: bool
    running: bool
    topic: str
    group_id: str
    processed: int = 0
    inserted: int = 0
    duplicates: int = 0
    failed: int = 0
    last_error: str | None = None


class AccessEventConsumerService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.status = ConsumerStatus(
            enabled=settings.kafka_consumer_enabled,
            running=False,
            topic=settings.kafka_access_events_topic,
            group_id=settings.kafka_consumer_group_id,
        )
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        # Set while consuming so each handled event can be marked "persisted" for
        # the Redis recovery fallback. None outside the run loop (and in tests),
        # where _mark_persisted becomes a no-op.
        self._redis: Redis | None = None

    def start(self) -> None:
        if not self.settings.kafka_consumer_enabled or self._task is not None:
            return
        self._task = asyncio.create_task(self._run(), name="access-event-consumer")

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
                logger.exception("access event consumer crashed")
                await asyncio.sleep(retry_seconds)
                retry_seconds = min(retry_seconds * 2, 30)

    async def _consume_forever(self) -> None:
        consumer = AIOKafkaConsumer(
            self.settings.kafka_access_events_topic,
            bootstrap_servers=self.settings.kafka_broker_list,
            group_id=self.settings.kafka_consumer_group_id,
            auto_offset_reset=self.settings.kafka_auto_offset_reset,
            enable_auto_commit=False,
        )

        # Only mark persisted events when the recovery fallback is enabled to
        # read them; otherwise the marker write is pure overhead.
        if self.settings.redis_recovery_enabled:
            self._redis = Redis.from_url(self.settings.redis_url, decode_responses=True)

        await consumer.start()
        self.status.running = True
        self.status.last_error = None
        logger.info(
            "access event consumer started topic=%s group=%s brokers=%s",
            self.settings.kafka_access_events_topic,
            self.settings.kafka_consumer_group_id,
            ",".join(self.settings.kafka_broker_list),
        )

        try:
            async for message in consumer:
                if self._stop_event.is_set():
                    break
                committed = await self._handle_with_retry(
                    message.value, dict(message.headers or [])
                )
                if not committed:
                    # Only reached when we are shutting down mid-retry. Leave the
                    # offset uncommitted so the message is redelivered next start.
                    break
                await consumer.commit()
        finally:
            self.status.running = False
            await consumer.stop()
            if self._redis is not None:
                redis, self._redis = self._redis, None
                await redis.aclose()
            logger.info("access event consumer stopped")

    async def _handle_with_retry(self, raw: bytes, headers: dict[str, bytes]) -> bool:
        """Persist a message, retrying in place with backoff on transient failures.

        Returns True once the message is handled (persisted, deduplicated, or
        skipped as a poison message) and its offset may be committed. Returns
        False only if shutdown is requested before the message could be handled,
        in which case the offset is intentionally left uncommitted.

        Unlike a connection-level crash-and-reconnect, this keeps the Kafka
        connection open so that when the downstream (e.g. the database) recovers
        the consumer resumes immediately from the failed message.
        """
        backoff = self.settings.kafka_consume_retry_initial_seconds
        while not self._stop_event.is_set():
            if await self._handle_message(raw, headers):
                return True
            logger.warning(
                "access event not persisted; retrying same message in %.1fs", backoff
            )
            await self._sleep_or_stop(backoff)
            backoff = min(backoff * 2, self.settings.kafka_consume_retry_max_seconds)
        return False

    async def _sleep_or_stop(self, seconds: float) -> None:
        """Sleep for ``seconds`` but wake immediately if shutdown is requested."""
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._stop_event.wait(), timeout=seconds)

    async def _handle_message(self, raw: bytes, headers: dict[str, bytes] | None = None) -> bool:
        try:
            payload = parse_access_event(raw)
            self._merge_trace_headers(payload, headers or {})
        except Exception as exc:
            self.status.failed += 1
            self.status.last_error = str(exc)
            logger.exception("failed to parse access event; committing offset to skip poison message")
            return True

        try:
            with access_event_consumer_span(payload, "kafka"):
                inserted = await asyncio.to_thread(save_access_event, payload)
            self.status.processed += 1
            if inserted:
                self.status.inserted += 1
            else:
                self.status.duplicates += 1
            await self._mark_persisted(payload.get("requestId"))
            return True
        except Exception as exc:
            self.status.failed += 1
            self.status.last_error = str(exc)
            logger.exception("failed to persist access event")
            return False

    async def _mark_persisted(self, request_id: object) -> None:
        """Tell the Redis recovery fallback this event is already handled.

        Best-effort: a marker failure must never block or fail Kafka consumption,
        because the recovery consumer's DB-level dedup still prevents duplicates.
        """
        if self._redis is None or not request_id:
            return
        key = self.settings.redis_persisted_marker_prefix + str(request_id)
        try:
            await self._redis.set(
                key, "1", ex=self.settings.redis_persisted_marker_ttl_seconds
            )
        except Exception:
            logger.warning("failed to set persisted marker for %s", request_id)

    def _merge_trace_headers(self, payload: dict, headers: dict[str, bytes]) -> None:
        for key in ("traceparent", "tracestate"):
            value = headers.get(key)
            if value and not payload.get(key):
                payload[key] = value.decode("utf-8")
