import unittest
from unittest.mock import patch

from app.config import Settings
from app.consumers.access_events import AccessEventConsumerService
from app.consumers.redis_recovery import RedisRecoveryConsumerService


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


if __name__ == "__main__":
    unittest.main()
