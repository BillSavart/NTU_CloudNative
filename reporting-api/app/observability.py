from __future__ import annotations

import os
import time
from contextlib import contextmanager
from collections.abc import Callable
from typing import Any, Iterator

from fastapi import FastAPI, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
from starlette.middleware.base import BaseHTTPMiddleware


HTTP_REQUESTS_TOTAL = Counter(
    "reporting_api_http_requests_total",
    "Total HTTP requests handled by the Reporting API.",
    ("method", "path", "status"),
)
HTTP_REQUEST_DURATION_SECONDS = Histogram(
    "reporting_api_http_request_duration_seconds",
    "HTTP request latency for the Reporting API.",
    ("method", "path"),
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5),
)
CONSUMER_RUNNING = Gauge(
    "reporting_api_consumer_running",
    "Whether a background consumer is running.",
    ("consumer",),
)
CONSUMER_PROCESSED_TOTAL = Gauge(
    "reporting_api_consumer_processed_total",
    "Total events processed by a background consumer.",
    ("consumer",),
)
CONSUMER_INSERTED_TOTAL = Gauge(
    "reporting_api_consumer_inserted_total",
    "Total new events inserted by a background consumer.",
    ("consumer",),
)
CONSUMER_DUPLICATES_TOTAL = Gauge(
    "reporting_api_consumer_duplicates_total",
    "Total duplicate events skipped by a background consumer.",
    ("consumer",),
)
CONSUMER_FAILED_TOTAL = Gauge(
    "reporting_api_consumer_failed_total",
    "Total failed events observed by a background consumer.",
    ("consumer",),
)


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        route_path = request.url.path
        start = time.perf_counter()
        response = await call_next(request)
        elapsed = time.perf_counter() - start

        route = request.scope.get("route")
        if route is not None and getattr(route, "path", None):
            route_path = route.path

        HTTP_REQUESTS_TOTAL.labels(request.method, route_path, str(response.status_code)).inc()
        HTTP_REQUEST_DURATION_SECONDS.labels(request.method, route_path).observe(elapsed)
        return response


def install_observability(app: FastAPI) -> None:
    app.add_middleware(MetricsMiddleware)
    _install_tracing(app)

    @app.get("/metrics", include_in_schema=False)
    def metrics() -> Response:
        _sync_consumer_metrics(app)
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


def _sync_consumer_metrics(app: FastAPI) -> None:
    consumers = {
        "kafka": getattr(app.state, "access_event_consumer", None),
        "redis_recovery": getattr(app.state, "redis_recovery_consumer", None),
    }
    for name, consumer in consumers.items():
        status = getattr(consumer, "status", None)
        if status is None:
            CONSUMER_RUNNING.labels(name).set(0)
            continue

        CONSUMER_RUNNING.labels(name).set(1 if status.running else 0)
        CONSUMER_PROCESSED_TOTAL.labels(name).set(status.processed)
        CONSUMER_INSERTED_TOTAL.labels(name).set(status.inserted)
        CONSUMER_DUPLICATES_TOTAL.labels(name).set(status.duplicates)
        CONSUMER_FAILED_TOTAL.labels(name).set(status.failed)


def _install_tracing(app: FastAPI) -> None:
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        return

    service_name = os.getenv("OTEL_SERVICE_NAME", "reporting-api")
    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)


@contextmanager
def access_event_consumer_span(payload: dict[str, Any], source: str) -> Iterator[None]:
    try:
        from opentelemetry import propagate, trace
    except ImportError:
        yield
        return

    carrier = {
        "traceparent": str(payload.get("traceparent") or ""),
        "tracestate": str(payload.get("tracestate") or ""),
    }
    context = propagate.extract(carrier)
    tracer = trace.get_tracer("reporting-api.consumer")
    with tracer.start_as_current_span(
        "persist access event",
        context=context,
        attributes={
            "messaging.system": source,
            "access.request_id": str(payload.get("requestId") or ""),
            "access.employee_id": str(payload.get("employeeId") or ""),
            "access.gate_id": str(payload.get("gateId") or ""),
            "access.direction": str(payload.get("direction") or ""),
            "access.decision": str(payload.get("decision") or ""),
        },
    ):
        yield
