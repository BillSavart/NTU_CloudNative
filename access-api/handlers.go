package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

type App struct {
	cfg        Config
	store      AccessStore
	publisher  EventPublisher
	instanceID string

	totalSwipes    atomic.Int64
	grantedSwipes  atomic.Int64
	deniedSwipes   atomic.Int64
	bufferedEvents atomic.Int64

	swipeLatencyCount     atomic.Int64
	swipeLatencySumMicros atomic.Int64
	swipeLatencyBuckets   [accessLatencyBucketCount]atomic.Int64
}

type AccessStore interface {
	Ping(ctx context.Context) error
	DecideAccess(ctx context.Context, employeeID, direction string) (AccessDecision, error)
	GetState(ctx context.Context, employeeID string) (string, bool, error)
	ResetState(ctx context.Context, employeeID string) error
	AppendEventOnce(ctx context.Context, event AccessEvent) error
	ListEvents(ctx context.Context, limit int64) ([]EventDTO, error)
}

const accessLatencyBucketCount = 9

var accessLatencyBucketSeconds = [accessLatencyBucketCount]float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5}

func NewApp(cfg Config, store AccessStore, publisher EventPublisher) *App {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "unknown"
	}
	return &App{cfg: cfg, store: store, publisher: publisher, instanceID: hostname}
}

func (a *App) Ping(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"message":    "pong",
		"status":     "Access API is running",
		"instanceId": a.instanceID,
	})
}

func (a *App) Healthz(c *gin.Context) {
	if err := a.store.Ping(c.Request.Context()); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"status":     "degraded",
			"redis":      "unavailable",
			"error":      err.Error(),
			"instanceId": a.instanceID,
		})
		return
	}

	if err := a.publisher.Health(c.Request.Context()); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"status":     "degraded",
			"redis":      "ok",
			"publisher":  a.publisher.Name(),
			"error":      err.Error(),
			"instanceId": a.instanceID,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":     "ok",
		"redis":      "ok",
		"publisher":  a.publisher.Name(),
		"instanceId": a.instanceID,
	})
}

func (a *App) Swipe(c *gin.Context) {
	start := time.Now()

	var req SwipeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": err.Error()})
		return
	}

	req.EmployeeID = strings.TrimSpace(req.EmployeeID)
	req.GateID = strings.TrimSpace(req.GateID)
	req.Direction = strings.ToUpper(strings.TrimSpace(req.Direction))

	if req.EmployeeID == "" || req.GateID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"message": "employeeId and gateId are required"})
		return
	}

	if req.Direction != DirectionIn && req.Direction != DirectionOut {
		c.JSON(http.StatusBadRequest, gin.H{
			"decision": DecisionDenied,
			"reason":   ReasonInvalidDirection,
			"message":  "direction must be IN or OUT",
		})
		return
	}

	decision, err := a.store.DecideAccess(c.Request.Context(), req.EmployeeID, req.Direction)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"decision": DecisionDenied,
			"reason":   "CACHE_UNAVAILABLE",
			"message":  err.Error(),
		})
		return
	}

	latency := time.Since(start)
	latencyMs := durationToLatencyMs(latency)
	requestID := newRequestID(req.EmployeeID)
	decisionText := DecisionDenied
	if decision.Granted {
		decisionText = DecisionGranted
	}

	a.recordMetrics(decision.Granted, latency)

	now := time.Now().UTC()
	event := AccessEvent{
		RequestID:     requestID,
		EmployeeID:    req.EmployeeID,
		GateID:        req.GateID,
		Direction:     req.Direction,
		Decision:      decisionText,
		Reason:        decision.Reason,
		PreviousState: decision.PreviousState,
		CurrentState:  decision.CurrentState,
		LatencyMs:     latencyMs,
		Timestamp:     now,
	}
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(c.Request.Context(), carrier)
	event.TraceParent = carrier.Get("traceparent")
	event.TraceState = carrier.Get("tracestate")

	span := trace.SpanFromContext(c.Request.Context())
	span.SetAttributes(
		attribute.String("access.request_id", requestID),
		attribute.String("access.employee_id", req.EmployeeID),
		attribute.String("access.gate_id", req.GateID),
		attribute.String("access.direction", req.Direction),
		attribute.String("access.decision", decisionText),
		attribute.String("access.reason", decision.Reason),
	)

	eventBuffered := true
	if err := a.store.AppendEventOnce(c.Request.Context(), event); err != nil {
		log.Printf("failed to buffer access event in redis requestId=%s: %v", requestID, err)
		eventBuffered = false
	} else {
		a.bufferedEvents.Add(1)
	}

	kafkaQueued := true
	if err := a.publisher.Publish(c.Request.Context(), event); err != nil {
		log.Printf("failed to publish access event requestId=%s publisher=%s: %v", requestID, a.publisher.Name(), err)
		kafkaQueued = false
	}

	c.JSON(http.StatusOK, SwipeResponse{
		RequestID:     requestID,
		Decision:      decisionText,
		Reason:        decision.Reason,
		EmployeeID:    req.EmployeeID,
		GateID:        req.GateID,
		Direction:     req.Direction,
		PreviousState: decision.PreviousState,
		CurrentState:  decision.CurrentState,
		LatencyMs:     latencyMs,
		Timestamp:     now.Format(time.RFC3339Nano),
		EventBuffered: eventBuffered,
		KafkaQueued:   kafkaQueued,
	})
}

func durationToLatencyMs(duration time.Duration) int64 {
	if duration <= 0 {
		return 0
	}
	return int64((duration + time.Millisecond - time.Nanosecond) / time.Millisecond)
}

func (a *App) GetState(c *gin.Context) {
	employeeID := strings.TrimSpace(c.Param("employeeId"))
	state, exists, err := a.store.GetState(c.Request.Context(), employeeID)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"message": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"employeeId": employeeID,
		"state":      state,
		"exists":     exists,
	})
}

func (a *App) ResetState(c *gin.Context) {
	employeeID := strings.TrimSpace(c.Param("employeeId"))
	if err := a.store.ResetState(c.Request.Context(), employeeID); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"message": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"employeeId": employeeID,
		"state":      "UNKNOWN",
		"message":    "state reset",
	})
}

func (a *App) ListEvents(c *gin.Context) {
	limit, _ := strconv.ParseInt(c.DefaultQuery("limit", "20"), 10, 64)
	events, err := a.store.ListEvents(c.Request.Context(), limit)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"message": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"events": events})
}

func (a *App) Metrics(c *gin.Context) {
	publisherStats := a.publisher.Stats()
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	c.Header("Content-Type", "text/plain; version=0.0.4")
	c.String(http.StatusOK, fmt.Sprintf(`# HELP access_api_swipes_total Total fake badge swipe requests.
# TYPE access_api_swipes_total counter
access_api_swipes_total %d
# HELP access_api_swipes_granted_total Total granted fake badge swipe requests.
# TYPE access_api_swipes_granted_total counter
access_api_swipes_granted_total %d
# HELP access_api_swipes_denied_total Total denied fake badge swipe requests.
# TYPE access_api_swipes_denied_total counter
access_api_swipes_denied_total %d
# HELP access_api_events_queued_total Total events accepted into the async publisher queue.
# TYPE access_api_events_queued_total counter
access_api_events_queued_total %d
# HELP access_api_events_buffered_total Total events persisted to the local Redis recovery buffer.
# TYPE access_api_events_buffered_total counter
access_api_events_buffered_total %d
# HELP access_api_events_published_total Total events published to the configured publisher.
# TYPE access_api_events_published_total counter
access_api_events_published_total %d
# HELP access_api_events_failed_total Total publisher failures.
# TYPE access_api_events_failed_total counter
access_api_events_failed_total %d
# HELP access_api_events_retried_total Total events retried after publisher failures.
# TYPE access_api_events_retried_total counter
access_api_events_retried_total %d
# HELP access_api_events_dropped_total Total events dropped before publishing.
# TYPE access_api_events_dropped_total counter
access_api_events_dropped_total %d
# HELP access_api_event_queue_depth Current async publisher queue depth.
# TYPE access_api_event_queue_depth gauge
access_api_event_queue_depth %d
%s# HELP access_api_runtime_alloc_bytes Bytes of allocated heap objects in the Access API process.
# TYPE access_api_runtime_alloc_bytes gauge
access_api_runtime_alloc_bytes %d
# HELP access_api_runtime_sys_bytes Bytes of memory obtained from the OS by the Access API process.
# TYPE access_api_runtime_sys_bytes gauge
access_api_runtime_sys_bytes %d
# HELP access_api_runtime_goroutines Current number of goroutines in the Access API process.
# TYPE access_api_runtime_goroutines gauge
access_api_runtime_goroutines %d
`,
		a.totalSwipes.Load(),
		a.grantedSwipes.Load(),
		a.deniedSwipes.Load(),
		publisherStats.Queued.Load(),
		a.bufferedEvents.Load(),
		publisherStats.Published.Load(),
		publisherStats.Failed.Load(),
		publisherStats.Retried.Load(),
		publisherStats.Dropped.Load(),
		publisherStats.QueueDepth.Load(),
		a.formatSwipeLatencyHistogram(),
		mem.Alloc,
		mem.Sys,
		runtime.NumGoroutine(),
	))
}

func (a *App) recordMetrics(granted bool, latency time.Duration) {
	a.totalSwipes.Add(1)
	a.observeSwipeLatency(latency)
	if granted {
		a.grantedSwipes.Add(1)
		return
	}
	a.deniedSwipes.Add(1)
}

func (a *App) observeSwipeLatency(latency time.Duration) {
	if latency < 0 {
		latency = 0
	}
	a.swipeLatencyCount.Add(1)
	a.swipeLatencySumMicros.Add(latency.Microseconds())
	seconds := latency.Seconds()
	for i, bucket := range accessLatencyBucketSeconds {
		if seconds <= bucket {
			a.swipeLatencyBuckets[i].Add(1)
		}
	}
}

func (a *App) formatSwipeLatencyHistogram() string {
	var builder strings.Builder
	builder.WriteString("# HELP access_api_swipe_latency_seconds Swipe decision latency in seconds.\n")
	builder.WriteString("# TYPE access_api_swipe_latency_seconds histogram\n")
	for i, bucket := range accessLatencyBucketSeconds {
		fmt.Fprintf(&builder, "access_api_swipe_latency_seconds_bucket{le=\"%g\"} %d\n", bucket, a.swipeLatencyBuckets[i].Load())
	}
	count := a.swipeLatencyCount.Load()
	fmt.Fprintf(&builder, "access_api_swipe_latency_seconds_bucket{le=\"+Inf\"} %d\n", count)
	fmt.Fprintf(&builder, "access_api_swipe_latency_seconds_sum %.6f\n", float64(a.swipeLatencySumMicros.Load())/1000000)
	fmt.Fprintf(&builder, "access_api_swipe_latency_seconds_count %d\n", count)
	return builder.String()
}

func newRequestID(employeeID string) string {
	return fmt.Sprintf("%s-%d", employeeID, time.Now().UnixNano())
}
