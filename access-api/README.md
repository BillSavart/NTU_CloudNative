# Access API

Go/Gin service for fake badge swipes, Redis anti-passback checks, and Kafka event buffering.

## Run

Start Redis and Kafka from the project root:

```bash
docker-compose up -d redis kafka
```

Kafka auto topic creation is enabled for local demos. If you want to create the topic explicitly:

```bash
docker-compose exec kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create \
  --if-not-exists \
  --topic access-events \
  --partitions 3 \
  --replication-factor 1
```

Run the API:

```bash
cd access-api
go run .
```

The default event path is Kafka:

```text
fake swipe -> Access API -> Redis anti-passback state -> Kafka topic access-events
```

`KAFKA_MIRROR_REDIS=true` is enabled by default, so the API also mirrors events into Redis Stream `access:events` for easy local demo inspection.

## Endpoints

- `GET /ping`: basic service check.
- `GET /healthz`: checks Redis and Kafka availability.
- `POST /api/access/swipe`: accepts a fake badge swipe and returns a gate decision.
- `GET /api/access/state/:employeeId`: reads the current cached IN/OUT state.
- `POST /api/access/reset/:employeeId`: clears one employee state for demos.
- `GET /api/access/events?limit=20`: reads recent mirrored Redis Stream events.
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

Read Kafka events directly:

```bash
docker-compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic access-events \
  --from-beginning \
  --max-messages 3
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
