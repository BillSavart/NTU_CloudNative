# Access API

Go/Gin service for fake badge swipes, anti-passback checks, and async event buffering.

## Run

Start Redis from the project root:

```bash
docker-compose up -d redis
```

Run the API:

```bash
cd access-api
go run .
```

## Endpoints

- `GET /ping`: basic service check.
- `GET /healthz`: checks Redis availability.
- `POST /api/access/swipe`: accepts a fake badge swipe and returns a gate decision.
- `GET /api/access/state/:employeeId`: reads the current cached IN/OUT state.
- `POST /api/access/reset/:employeeId`: clears one employee state for demos.
- `GET /api/access/events?limit=20`: reads recent Redis Stream events.
- `GET /metrics`: Prometheus-style counters for demo observability.

## Demo Flow

Reset demo state:

```bash
curl -X POST http://localhost:8080/api/access/reset/E000001
```

First entry should be granted:

```bash
curl -X POST http://localhost:8080/api/access/swipe \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"E000001","gateId":"GATE_A","direction":"IN"}'
```

Repeated entry should be denied by anti-passback:

```bash
curl -X POST http://localhost:8080/api/access/swipe \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"E000001","gateId":"GATE_A","direction":"IN"}'
```

Exit should be granted:

```bash
curl -X POST http://localhost:8080/api/access/swipe \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"E000001","gateId":"GATE_A","direction":"OUT"}'
```

Read buffered events:

```bash
curl 'http://localhost:8080/api/access/events?limit=3'
```

## Peak Traffic Simulation

Run a compressed 30-minute morning rush simulation for a 90,000-person company with 50 gates:

```bash
go run ./cmd/swipe-simulator
```

By default, the simulator sends about 92,700 fake swipes: one first swipe per employee plus 3% duplicate entry swipes to exercise anti-passback. The 30-minute peak is compressed by `--time-scale=60`, so it runs in about 30 real seconds.

Useful options:

```bash
go run ./cmd/swipe-simulator \
  --base-url http://127.0.0.1:8080 \
  --employees 90000 \
  --employee-prefix E \
  --gates 50 \
  --duration 30m \
  --time-scale 60 \
  --workers 200
```

For a quick smoke test:

```bash
go run ./cmd/swipe-simulator --employees 1000 --employee-prefix TEST --duration 2m --time-scale 120
```
