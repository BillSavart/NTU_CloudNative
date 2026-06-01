import unittest
from unittest.mock import AsyncMock, patch

from app.config import Settings
from app.consumers.access_events import AccessEventConsumerService
from app.consumers.redis_recovery import RedisRecoveryConsumerService


def _stream_fields(request_id: str = "req-1") -> dict[str, str]:
    return {
        "requestId": request_id,
        "employeeId": "E1",
        "gateId": "G1",
        "direction": "IN",
        "decision": "GRANTED",
        "reason": "ACCESS_ALLOWED",
        "previousState": "UNKNOWN",
        "currentState": "IN",
        "latencyMs": "3",
        "timestamp": "2026-05-20T09:04:50Z",
    }


class ConsumerTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_kafka_consumer_commits_poison_message_after_parse_failure(self) -> None:
        service = AccessEventConsumerService(Settings())

        should_commit = await service._handle_message(b'{"requestId":"missing-fields"}')

        self.assertTrue(should_commit)
        self.assertEqual(service.status.failed, 1)
        self.assertIsNotNone(service.status.last_error)

    async def test_kafka_consumer_counts_duplicate_writes(self) -> None:
        service = AccessEventConsumerService(Settings())
        payload = (
            b'{"requestId":"req-1","employeeId":"E1","gateId":"G1","direction":"IN",'
            b'"decision":"GRANTED","reason":"ACCESS_ALLOWED","previousState":"UNKNOWN",'
            b'"currentState":"IN","latencyMs":3,"timestamp":"2026-05-20T09:04:50Z"}'
        )

        with patch("app.consumers.access_events.save_access_event", return_value=False):
            should_commit = await service._handle_message(payload)

        self.assertTrue(should_commit)
        self.assertEqual(service.status.processed, 1)
        self.assertEqual(service.status.duplicates, 1)

    async def test_redis_recovery_acks_malformed_stream_message(self) -> None:
        service = RedisRecoveryConsumerService(Settings())

        should_ack = await service._handle_message({"requestId": "missing-fields"})

        self.assertTrue(should_ack)
        self.assertEqual(service.status.failed, 1)

    async def test_redis_recovery_keeps_message_pending_when_db_write_fails(self) -> None:
        service = RedisRecoveryConsumerService(Settings())
        fields = {
            "requestId": "req-1",
            "employeeId": "E1",
            "gateId": "G1",
            "direction": "IN",
            "decision": "GRANTED",
            "reason": "ACCESS_ALLOWED",
            "previousState": "UNKNOWN",
            "currentState": "IN",
            "latencyMs": "3",
            "timestamp": "2026-05-20T09:04:50Z",
        }

        with patch("app.consumers.redis_recovery.save_access_event", side_effect=RuntimeError("db down")):
            should_ack = await service._handle_message(fields)

        self.assertFalse(should_ack)
        self.assertEqual(service.status.failed, 1)
        self.assertIn("db down", service.status.last_error or "")


    async def test_kafka_consumer_marks_event_persisted(self) -> None:
        service = AccessEventConsumerService(Settings())
        service._redis = AsyncMock()
        payload = (
            b'{"requestId":"req-mark","employeeId":"E1","gateId":"G1","direction":"IN",'
            b'"decision":"GRANTED","reason":"ACCESS_ALLOWED","previousState":"UNKNOWN",'
            b'"currentState":"IN","latencyMs":3,"timestamp":"2026-05-20T09:04:50Z"}'
        )

        with patch("app.consumers.access_events.save_access_event", return_value=True):
            should_commit = await service._handle_message(payload)

        self.assertTrue(should_commit)
        service._redis.set.assert_awaited_once()
        key = service._redis.set.call_args.args[0]
        self.assertIn("req-mark", key)

    async def test_kafka_marker_is_noop_without_redis(self) -> None:
        # No _redis (tests / recovery disabled): handling must still succeed.
        service = AccessEventConsumerService(Settings())
        with patch("app.consumers.access_events.save_access_event", return_value=True):
            should_commit = await service._handle_message(
                b'{"requestId":"r","employeeId":"E1","gateId":"G1","direction":"IN",'
                b'"decision":"GRANTED","reason":"ACCESS_ALLOWED","previousState":"UNKNOWN",'
                b'"currentState":"IN","latencyMs":3,"timestamp":"2026-05-20T09:04:50Z"}'
            )
        self.assertTrue(should_commit)
        self.assertEqual(service.status.processed, 1)

    async def test_redis_recovery_skips_entry_already_persisted_by_kafka(self) -> None:
        service = RedisRecoveryConsumerService(Settings(redis_recovery_grace_seconds=0))
        redis = AsyncMock()
        redis.exists.return_value = 1

        with patch("app.consumers.redis_recovery.save_access_event") as save:
            should_ack = await service._process_entry(redis, "1-0", _stream_fields())

        self.assertTrue(should_ack)
        save.assert_not_called()
        self.assertEqual(service.status.processed, 0)

    async def test_redis_recovery_persists_when_kafka_left_no_marker(self) -> None:
        service = RedisRecoveryConsumerService(Settings(redis_recovery_grace_seconds=0))
        redis = AsyncMock()
        redis.exists.return_value = 0

        with patch("app.consumers.redis_recovery.save_access_event", return_value=True):
            should_ack = await service._process_entry(redis, "1-0", _stream_fields())

        self.assertTrue(should_ack)
        self.assertEqual(service.status.processed, 1)
        self.assertEqual(service.status.inserted, 1)


if __name__ == "__main__":
    unittest.main()
