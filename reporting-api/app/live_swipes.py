"""Continuous live swipe generator for demos.

Unlike app.fake_data (which writes historical rows straight into PostgreSQL),
this drives the REAL request path: it POSTs swipes to the Access API over the
internal network, so events flow Access -> Redis -> Kafka -> Reporting and the
dashboards update live with people entering/leaving while you present.

Runs forever; stop it by stopping the container. Stdlib only (no extra deps) so
it can run inside the existing reporting-api image.

Env:
  ACCESS_BASE_URL       Access API / LB base URL (default http://access-lb:8080)
  LIVE_SWIPES_PER_MIN   target swipes per minute   (default 60)
  LIVE_EMPLOYEE_SAMPLE  how many real employees to cycle (default 3000)
  POSTGRES_*            used to read the employee sample (same as the app)
"""
from __future__ import annotations

import json
import os
import random
import time
import urllib.request
from datetime import datetime

from sqlalchemy import text

from app.database import SessionLocal

ACCESS_BASE_URL = os.getenv("ACCESS_BASE_URL", "http://access-lb:8080").rstrip("/")
PER_MIN = max(int(os.getenv("LIVE_SWIPES_PER_MIN", "60")), 1)
SAMPLE = max(int(os.getenv("LIVE_EMPLOYEE_SAMPLE", "3000")), 1)
GATE_DOORS = ("B", "C", "D", "E")


def _log(msg: str) -> None:
    print(f"[live-swipes {datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)


def load_sample() -> list[dict]:
    """Pick a random set of real employees + their current state and fab number."""
    with SessionLocal() as db:
        rows = db.execute(
            text(
                """
                SELECT employee_id,
                       COALESCE((regexp_match(department_id, '([0-9]+)$'))[1], '1') AS fab,
                       last_known_state
                FROM employees
                WHERE department_id IS NOT NULL AND department_id <> 'TSMC'
                ORDER BY random()
                LIMIT :n
                """
            ),
            {"n": SAMPLE},
        ).all()
    return [
        {"employee_id": r.employee_id, "fab": r.fab, "state": (r.last_known_state or "OUT")}
        for r in rows
    ]


def post_swipe(employee_id: str, gate_id: str, direction: str) -> dict | None:
    body = json.dumps({"employeeId": employee_id, "gateId": gate_id, "direction": direction}).encode()
    req = urllib.request.Request(
        f"{ACCESS_BASE_URL}/api/access/swipe",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception:  # noqa: BLE001 - keep the loop alive through transient errors
        return None


def main() -> None:
    # Wait for the employee sample to exist (DB may still be seeding on first boot).
    sample: list[dict] = []
    for _ in range(60):
        sample = load_sample()
        if sample:
            break
        _log("no employees yet; retrying in 5s (seed/fake_data not loaded?)")
        time.sleep(5)
    if not sample:
        _log("no employees found after waiting; exiting")
        return

    state = {e["employee_id"]: e["state"] for e in sample}
    fab = {e["employee_id"]: e["fab"] for e in sample}
    ids = list(state.keys())
    interval = 60.0 / PER_MIN
    _log(f"driving ~{PER_MIN} swipes/min over {len(ids)} employees -> {ACCESS_BASE_URL}")

    granted = denied = 0
    last_report = time.monotonic()
    while True:
        emp = random.choice(ids)
        current = state.get(emp, "OUT")
        direction = "OUT" if current == "IN" else "IN"
        # Most in/out at the main gate; occasionally an interior-door move while inside.
        if current == "IN" and random.random() < 0.25:
            gate = f"gate_{fab[emp]}_{random.choice(GATE_DOORS)}"
        else:
            gate = f"gate_{fab[emp]}_A"

        resp = post_swipe(emp, gate, direction)
        if resp and resp.get("decision") == "GRANTED":
            state[emp] = direction
            granted += 1
        else:
            denied += 1

        now = time.monotonic()
        if now - last_report >= 30:
            _log(f"granted={granted} denied={denied} inside~={sum(1 for s in state.values() if s == 'IN')}")
            last_report = now

        # Jittered pacing so swipes don't look metronomic.
        time.sleep(interval * random.uniform(0.4, 1.6))


if __name__ == "__main__":
    main()
