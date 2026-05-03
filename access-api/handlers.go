package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

type App struct {
	cfg   Config
	store *RedisStore

	totalSwipes   atomic.Int64
	grantedSwipes atomic.Int64
	deniedSwipes  atomic.Int64
}

func NewApp(cfg Config, store *RedisStore) *App {
	return &App{cfg: cfg, store: store}
}

func (a *App) Ping(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"message": "pong",
		"status":  "Access API is running",
	})
}

func (a *App) Healthz(c *gin.Context) {
	if err := a.store.Ping(c.Request.Context()); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"status": "degraded",
			"redis":  "unavailable",
			"error":  err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"redis":  "ok",
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

	latencyMs := time.Since(start).Milliseconds()
	requestID := newRequestID(req.EmployeeID)
	decisionText := DecisionDenied
	if decision.Granted {
		decisionText = DecisionGranted
	}

	a.recordMetrics(decision.Granted)

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

	eventBuffered := true
	if err := a.store.AppendEvent(c.Request.Context(), event); err != nil {
		eventBuffered = false
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
	})
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
`, a.totalSwipes.Load(), a.grantedSwipes.Load(), a.deniedSwipes.Load()))
}

func (a *App) recordMetrics(granted bool) {
	a.totalSwipes.Add(1)
	if granted {
		a.grantedSwipes.Add(1)
		return
	}
	a.deniedSwipes.Add(1)
}

func newRequestID(employeeID string) string {
	return fmt.Sprintf("%s-%d", employeeID, time.Now().UnixNano())
}
