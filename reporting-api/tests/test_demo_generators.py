import os
import unittest
from datetime import date, datetime, timedelta
from unittest.mock import MagicMock, patch

from app import fake_data, live_swipes, patch_fake_data


class FakeDataHelpersTestCase(unittest.TestCase):
    def test_parse_positive_int_uses_defaults_and_clamps_negative_values(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(fake_data.parse_positive_int("MISSING_VALUE", 12), 12)

        with patch.dict(os.environ, {"COUNT": "-4"}):
            self.assertEqual(fake_data.parse_positive_int("COUNT", 12), 0)

        with patch.dict(os.environ, {"COUNT": "not-a-number"}):
            self.assertEqual(fake_data.parse_positive_int("COUNT", 12), 12)

        with patch.dict(os.environ, {"COUNT": "30"}):
            self.assertEqual(fake_data.parse_positive_int("COUNT", 12), 30)

    def test_parse_bool_accepts_common_truthy_values(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertTrue(fake_data.parse_bool("FLAG", True))
            self.assertFalse(fake_data.parse_bool("FLAG", False))

        for value in ("1", "true", "yes", "y", " TRUE "):
            with self.subTest(value=value), patch.dict(os.environ, {"FLAG": value}):
                self.assertTrue(fake_data.parse_bool("FLAG", False))

        with patch.dict(os.environ, {"FLAG": "no"}):
            self.assertFalse(fake_data.parse_bool("FLAG", True))

    def test_build_work_days_returns_contiguous_dates_through_today(self) -> None:
        days = fake_data.build_work_days(3, include_weekends=False)

        self.assertEqual(len(days), 3)
        self.assertEqual(days[-1], datetime.now(fake_data.TAIPEI).date())
        self.assertEqual(days[1] - days[0], timedelta(days=1))
        self.assertEqual(days[2] - days[1], timedelta(days=1))

    def test_build_work_days_handles_zero_days_as_today_only(self) -> None:
        self.assertEqual(fake_data.build_work_days(0, include_weekends=True), [datetime.now(fake_data.TAIPEI).date()])

    def test_human_name_is_deterministic(self) -> None:
        self.assertEqual(fake_data.human_name(0), "Michael Jackson")
        self.assertEqual(fake_data.human_name(len(fake_data.FIRST_NAMES)), "Michael Wang")

    def test_seed_ordinary_employees_batches_valid_demo_rows(self) -> None:
        db = MagicMock()

        with patch.object(fake_data, "upsert_employees") as upsert:
            fake_data.seed_ordinary_employees(db, 3)

        upsert.assert_called_once()
        self.assertIs(upsert.call_args.args[0], db)
        rows = upsert.call_args.args[1]
        self.assertEqual([row["employee_id"] for row in rows], ["200000", "200001", "200002"])
        self.assertEqual(rows[0]["display_name"], "Michael Jackson")
        self.assertTrue(rows[0]["department_id"].startswith("RD_"))

    def test_patch_parse_positive_int_matches_fake_data_behavior(self) -> None:
        with patch.dict(os.environ, {"PATCH_DENIED_EVENTS": "7"}):
            self.assertEqual(patch_fake_data.parse_positive_int("PATCH_DENIED_EVENTS", 1), 7)
        with patch.dict(os.environ, {"PATCH_DENIED_EVENTS": "bad"}):
            self.assertEqual(patch_fake_data.parse_positive_int("PATCH_DENIED_EVENTS", 1), 1)


class LiveSwipesTestCase(unittest.TestCase):
    def test_load_sample_reads_real_employee_state_with_out_default(self) -> None:
        row_with_state = MagicMock(employee_id="100001", fab="1", last_known_state="IN")
        row_without_state = MagicMock(employee_id="100002", fab="2", last_known_state=None)
        db = MagicMock()
        db.execute.return_value.all.return_value = [row_with_state, row_without_state]
        session = MagicMock()
        session.__enter__.return_value = db

        with patch.object(live_swipes, "SessionLocal", return_value=session):
            self.assertEqual(
                live_swipes.load_sample(),
                [
                    {"employee_id": "100001", "fab": "1", "state": "IN"},
                    {"employee_id": "100002", "fab": "2", "state": "OUT"},
                ],
            )

    def test_post_swipe_returns_decoded_access_api_response(self) -> None:
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"decision":"GRANTED"}'

        with patch.object(live_swipes.urllib.request, "urlopen", return_value=response) as urlopen:
            result = live_swipes.post_swipe("100001", "gate_1_A", "IN")

        self.assertEqual(result, {"decision": "GRANTED"})
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, f"{live_swipes.ACCESS_BASE_URL}/api/access/swipe")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.headers["Content-type"], "application/json")

    def test_post_swipe_keeps_demo_loop_alive_on_transient_errors(self) -> None:
        with patch.object(live_swipes.urllib.request, "urlopen", side_effect=TimeoutError):
            self.assertIsNone(live_swipes.post_swipe("100001", "gate_1_A", "IN"))

    def test_main_exits_when_employee_sample_never_arrives(self) -> None:
        with (
            patch.object(live_swipes, "load_sample", return_value=[]),
            patch.object(live_swipes.time, "sleep"),
            patch.object(live_swipes, "_log") as log,
        ):
            live_swipes.main()

        self.assertIn("no employees found", log.call_args_list[-1].args[0])

    def test_main_alternates_state_after_granted_swipe(self) -> None:
        sample = [{"employee_id": "100001", "fab": "1", "state": "OUT"}]
        calls = {"sleep": 0}

        def stop_after_first_sleep(_seconds: float) -> None:
            calls["sleep"] += 1
            raise KeyboardInterrupt

        with (
            patch.object(live_swipes, "load_sample", return_value=sample),
            patch.object(live_swipes.random, "choice", return_value="100001"),
            patch.object(live_swipes.random, "random", return_value=0.9),
            patch.object(live_swipes.random, "uniform", return_value=1.0),
            patch.object(live_swipes, "post_swipe", return_value={"decision": "GRANTED"}) as post_swipe,
            patch.object(live_swipes.time, "monotonic", return_value=0),
            patch.object(live_swipes.time, "sleep", side_effect=stop_after_first_sleep),
        ):
            with self.assertRaises(KeyboardInterrupt):
                live_swipes.main()

        post_swipe.assert_called_once_with("100001", "gate_1_A", "IN")
        self.assertEqual(calls["sleep"], 1)


if __name__ == "__main__":
    unittest.main()
