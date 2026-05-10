import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass

from aiokafka import AIOKafkaConsumer

from app.config import Settings
from app.repositories import parse_access_event, save_access_event


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
                should_commit = await self._handle_message(message.value)
                if not should_commit:
                    raise RuntimeError("access event was not persisted; retrying without offset commit")
                await consumer.commit()
        finally:
            self.status.running = False
            await consumer.stop()
            logger.info("access event consumer stopped")

    async def _handle_message(self, raw: bytes) -> bool:
        try:
            payload = parse_access_event(raw)
        except Exception as exc:
            self.status.failed += 1
            self.status.last_error = str(exc)
            logger.exception("failed to parse access event; committing offset to skip poison message")
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
            logger.exception("failed to persist access event")
            return False
