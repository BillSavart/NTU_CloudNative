package main

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

func SetupTracing(ctx context.Context, cfg Config) func(context.Context) error {
	endpoint := strings.TrimSpace(cfg.OtelTracesEndpoint)
	if endpoint == "" {
		otel.SetTextMapPropagator(propagation.TraceContext{})
		return func(context.Context) error { return nil }
	}

	exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint))
	if err != nil {
		log.Printf("failed to initialize OTLP trace exporter: %v", err)
		return func(context.Context) error { return nil }
	}

	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(2*time.Second)),
		sdktrace.WithResource(resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(cfg.OtelServiceName),
		)),
	)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return provider.Shutdown
}

func TracingMiddleware(cfg Config) gin.HandlerFunc {
	if strings.TrimSpace(cfg.OtelTracesEndpoint) == "" {
		return func(c *gin.Context) {
			c.Next()
		}
	}
	return otelgin.Middleware(cfg.OtelServiceName)
}
