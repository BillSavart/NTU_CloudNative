# Observability

This folder contains the optional Observability layer for the access-control system. It is intended for IT/operations users, not the business reporting dashboard users.

The current implementation focuses on metrics with Prometheus and Grafana. Logs remain available through Docker logs, and distributed tracing is not included in this phase.

## What It Adds

- Prometheus scrape configuration for application and infrastructure metrics.
- Grafana provisioning for a Prometheus datasource and starter dashboard.
- Exporters for Redis, PostgreSQL, and Kafka.
- Reporting API `/metrics` endpoint for HTTP and background consumer metrics.
- Optional Docker Compose override so the base project can still run without the extra observability services.

## Files

```text
observability/
|-- README.md
|-- docker-compose.observability.yml
|-- prometheus/
|   `-- prometheus.yml
`-- grafana/
    `-- provisioning/
        |-- datasources/
        |   `-- prometheus.yml
        `-- dashboards/
            |-- dashboards.yml
            `-- json/
                `-- observability-dashboard.json

reporting-api/
|-- app/
|   `-- observability.py
`-- requirements-observability.txt
```

## Verification Flow

### 1. Start Stack

From the repository root, start the base stack plus the Observability override:

```bash
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml up -d --build
```

### 2. Optional: Check Containers

This step is optional, but useful before demos or after changing compose files:

```bash
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml ps
```

Expected result: the main services should be `Up`, and `access-api` should eventually show `healthy`.

### 3. Open Prometheus Targets

Open:

```text
http://localhost:9090/targets
```

Expected result: all configured targets should become `up`.

### 4. Open Grafana Dashboard

Open:

```text
http://localhost:3000
```

After login, open:

```text
Dashboards -> NTU Cloud Native -> Access Control Observability
```

Expected result: the dashboard loads and shows Prometheus-backed panels. Some panels may be empty until traffic is generated.

### 5. Generate Traffic

Run health checks or access-control swipe requests to generate metrics:

```bash
curl http://localhost:8080/ping
curl http://localhost:8000/api/health/
curl http://localhost:8000/metrics
```

For swipe traffic, see [Generate Traffic](#generate-traffic).

Expected result: Prometheus and Grafana start showing updated request counters, latency data, access decisions, and pipeline status after the next scrape interval.

### 6. Stop Stack

Stop containers:

```bash
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml down
```

Stop containers and delete local Docker volumes:

```bash
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml down -v
```

Only use `down -v` when local PostgreSQL, Redis, Kafka, Prometheus, and Grafana data can be deleted.

## Useful Pages

| Tool | URL | Purpose |
| --- | --- | --- |
| Access API | `http://localhost:8080/ping` | Basic Access API check |
| Reporting API | `http://localhost:8000/api/health/` | Reporting API, DB, Kafka consumer, and Redis recovery health |
| Reporting metrics | `http://localhost:8000/metrics` | Reporting API Prometheus metrics |
| Prometheus | `http://localhost:9090` | Metrics query UI |
| Prometheus targets | `http://localhost:9090/targets` | Scrape status for monitored endpoints |
| Grafana | `http://localhost:3000` | Observability dashboard |

Grafana default local credentials come from `.env`:

```text
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=...
```

## Prometheus Targets

Open:

```text
http://localhost:9090/targets
```

Expected targets:

| Job | Docker endpoint | Source |
| --- | --- | --- |
| `access-api` | `access-lb:8080/metrics` | Access API metrics |
| `reporting-api` | `reporting-api:8000/metrics` | Reporting API metrics |
| `redis` | `redis-exporter:9121/metrics` | Redis exporter |
| `postgres` | `postgres-exporter:9187/metrics` | PostgreSQL exporter |
| `kafka` | `kafka-exporter:9308/metrics` | Kafka exporter |
| `prometheus` | `prometheus:9090/metrics` | Prometheus self metrics |

Each target should be `up`. In Prometheus, `up` means the endpoint is reachable and metrics were scraped successfully.

Some target endpoints use Docker-internal service names such as `reporting-api:8000` or `kafka-exporter:9308`. These names are meant for containers inside the Docker network. From the Windows host, use the published localhost URLs instead:

```text
http://localhost:8000/metrics
http://localhost:9121/metrics
http://localhost:9187/metrics
http://localhost:9308/metrics
```

The Grafana starter dashboard includes:

- Traffic
- Event pipeline status
- Failure rate
- Reporting API p95 latency
- Access decision ratio

If graphs are empty, generate traffic and wait for Prometheus to scrape new samples.

## Generate Traffic

Basic health requests:

```bash
curl http://localhost:8080/ping
curl http://localhost:8000/api/health/
curl http://localhost:8000/metrics
```

Access-control swipe flow:

```bash
curl -X POST http://localhost:8080/api/access/reset/OBS001

curl -X POST http://localhost:8080/api/access/swipe \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"OBS001","gateId":"GATE_A","direction":"IN"}'

curl -X POST http://localhost:8080/api/access/swipe \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"OBS001","gateId":"GATE_A","direction":"IN"}'

curl -X POST http://localhost:8080/api/access/swipe \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"OBS001","gateId":"GATE_A","direction":"OUT"}'
```

The first `IN` should usually be granted, the duplicate `IN` should be denied by anti-passback logic, and `OUT` should be granted.

On Windows PowerShell, prefer `curl.exe`:

```powershell
curl.exe -X POST http://localhost:8080/api/access/swipe -H "Content-Type: application/json" -d "{\"employeeId\":\"OBS001\",\"gateId\":\"GATE_A\",\"direction\":\"IN\"}"
```

You can also use the existing project demo scripts, for example:

```powershell
.\scripts\demo-access-api.ps1
```

## Frontend

The current Docker Compose stack does not run the React frontend. To run it locally:

```bash
cd frontend
npm install
npm run dev
```

Then open the Vite URL printed in the terminal, usually:

```text
http://localhost:5173
```

The frontend uses the Reporting API through the local Vite proxy. Make sure the Docker Compose stack is already running.

## Key Metrics

Application metrics:

- `access_api_swipes_total`
- `access_api_swipes_granted_total`
- `access_api_swipes_denied_total`
- `access_api_events_failed_total`
- `access_api_event_queue_depth`
- `reporting_api_http_requests_total`
- `reporting_api_http_request_duration_seconds`
- `reporting_api_consumer_running`
- `reporting_api_consumer_failed_total`

Exporter metrics:

- Redis metrics are exposed through `redis-exporter`.
- PostgreSQL metrics are exposed through `postgres-exporter`.
- Kafka metrics are exposed through `kafka-exporter`.

## Labels

Prometheus labels identify and group metrics. Common labels include:

```text
job="reporting-api"
instance="reporting-api:8000"
```

On the targets page, discovered labels beginning with `__` are internal scrape metadata. Example:

```text
__address__="access-lb:8080"
__metrics_path__="/metrics"
__scheme__="http"
__scrape_interval__="5s"
__scrape_timeout__="5s"
job="access-api"
```

This means Prometheus scrapes:

```text
http://access-lb:8080/metrics
```

every 5 seconds.

## Exporters

An exporter is an adapter service that exposes another system's status in Prometheus `/metrics` format.

- `redis-exporter` reads Redis status.
- `postgres-exporter` reads PostgreSQL status.
- `kafka-exporter` reads Kafka broker/topic/consumer group status.

Access API and Reporting API expose metrics directly. Redis, PostgreSQL, and Kafka use exporters.

The exporters use:

```yaml
restart: on-failure
```

This is intentional. Exporters depend on their target services being ready. For example, Kafka containers can be `Running` before the broker listeners are ready to accept connections, so `kafka-exporter` may fail if it starts too early. Restarting on failure lets exporters recover from startup-order or short transient connection problems.

This does not hide a real dependency outage. If Redis, PostgreSQL, or Kafka stays unavailable, the related exporter will either keep failing or expose failed scrape behavior, and Prometheus will still show the target as `down` or report scrape errors. Use Prometheus targets and exporter logs together when diagnosing failures.

Prometheus and Grafana do not currently set an extra restart policy in this override. For this local/demo setup, keeping the main observability services' failures visible is preferable to automatically hiding them. In a longer-running environment, `restart: unless-stopped` could be added for Prometheus and Grafana.

## Logs and Traces

Current scope:

| Pillar | Current support |
| --- | --- |
| Metrics | Implemented with Prometheus and Grafana |
| Logs | Available through Docker logs only |
| Traces | Not implemented |

View container logs:

```bash
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml logs reporting-api
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml logs access-api
```

Possible future extensions:

- Logs: add Loki plus Promtail or Grafana Alloy.
- Traces: add OpenTelemetry instrumentation, OpenTelemetry Collector, and Tempo or Jaeger.

## Environment Notes

The `.env` file configures local secrets and ports. Do not commit `.env`.

Some environment values initialize persistent Docker volumes the first time services start. If values such as `POSTGRES_PASSWORD` or `GRAFANA_ADMIN_PASSWORD` are changed after volumes already exist, the old stored values may still apply. For a clean local reset, use `down -v` and start the stack again.
