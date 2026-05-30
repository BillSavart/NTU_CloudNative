package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type fakeStore struct {
	mu              sync.Mutex
	states          map[string]string
	events          []AccessEvent
	listEvents      []EventDTO
	failPing        bool
	failDecide      bool
	failGetState    bool
	failResetState  bool
	failAppendEvent bool
	failListEvents  bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{states: map[string]string{}}
}

func (s *fakeStore) Ping(ctx context.Context) error {
	if s.failPing {
		return errors.New("redis unavailable")
	}
	return nil
}

func (s *fakeStore) DecideAccess(ctx context.Context, employeeID, direction string) (AccessDecision, error) {
	if s.failDecide {
		return AccessDecision{}, errors.New("cache unavailable")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	current, exists := s.states[employeeID]
	if !exists {
		if direction == DirectionIn {
			s.states[employeeID] = DirectionIn
			return AccessDecision{Granted: true, PreviousState: "UNKNOWN", CurrentState: DirectionIn, Reason: ReasonAccessAllowed}, nil
		}
		return AccessDecision{Granted: false, PreviousState: "UNKNOWN", CurrentState: "UNKNOWN", Reason: ReasonNoEntryRecord}, nil
	}

	if current == direction {
		return AccessDecision{Granted: false, PreviousState: current, CurrentState: current, Reason: ReasonAntiPassbackViolation}, nil
	}

	s.states[employeeID] = direction
	return AccessDecision{Granted: true, PreviousState: current, CurrentState: direction, Reason: ReasonAccessAllowed}, nil
}

func (s *fakeStore) GetState(ctx context.Context, employeeID string) (string, bool, error) {
	if s.failGetState {
		return "", false, errors.New("state unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	state, exists := s.states[employeeID]
	if !exists {
		return "UNKNOWN", false, nil
	}
	return state, true, nil
}

func (s *fakeStore) ResetState(ctx context.Context, employeeID string) error {
	if s.failResetState {
		return errors.New("reset unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.states, employeeID)
	return nil
}

func (s *fakeStore) AppendEventOnce(ctx context.Context, event AccessEvent) error {
	if s.failAppendEvent {
		return errors.New("stream unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	s.events = append(s.events, event)
	return nil
}

func (s *fakeStore) ListEvents(ctx context.Context, limit int64) ([]EventDTO, error) {
	if s.failListEvents {
		return nil, errors.New("stream unavailable")
	}
	if int(limit) < len(s.listEvents) {
		return s.listEvents[:limit], nil
	}
	return s.listEvents, nil
}

type fakePublisher struct {
	publishErr error
	healthErr  error
	stats      PublisherStats
	published  []AccessEvent
}

func (p *fakePublisher) Publish(ctx context.Context, event AccessEvent) error {
	if p.publishErr != nil {
		p.stats.Dropped.Add(1)
		return p.publishErr
	}
	p.published = append(p.published, event)
	p.stats.Queued.Add(1)
	p.stats.Published.Add(1)
	return nil
}

func (p *fakePublisher) PublishBatch(ctx context.Context, events []AccessEvent) error {
	for _, event := range events {
		if err := p.Publish(ctx, event); err != nil {
			return err
		}
	}
	return nil
}

func (p *fakePublisher) Health(ctx context.Context) error {
	return p.healthErr
}

func (p *fakePublisher) Close() error {
	return nil
}

func (p *fakePublisher) Name() string {
	return "fake"
}

func (p *fakePublisher) Stats() PublisherStats {
	return p.stats
}

func setupTestRouter(store *fakeStore, publisher *fakePublisher) *gin.Engine {
	gin.SetMode(gin.TestMode)
	app := NewApp(Config{}, store, publisher)
	router := gin.New()
	router.GET("/healthz", app.Healthz)
	router.GET("/metrics", app.Metrics)
	api := router.Group("/api/access")
	api.POST("/swipe", app.Swipe)
	api.GET("/state/:employeeId", app.GetState)
	api.POST("/reset/:employeeId", app.ResetState)
	api.GET("/events", app.ListEvents)
	return router
}

func postSwipe(t *testing.T, router *gin.Engine, payload string) (*httptest.ResponseRecorder, SwipeResponse) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/access/swipe", bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	var response SwipeResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &response)
	return rec, response
}

func TestSwipeValidationErrors(t *testing.T) {
	router := setupTestRouter(newFakeStore(), &fakePublisher{})

	rec, _ := postSwipe(t, router, `{"employeeId":"","gateId":"GATE_1","direction":"IN"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing employeeId status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	rec, _ = postSwipe(t, router, `{"employeeId":"E1","gateId":"GATE_1","direction":"SIDEWAYS"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid direction status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if !strings.Contains(rec.Body.String(), ReasonInvalidDirection) {
		t.Fatalf("invalid direction response = %s, want reason %s", rec.Body.String(), ReasonInvalidDirection)
	}
}

func TestSwipeAntiPassbackFlow(t *testing.T) {
	router := setupTestRouter(newFakeStore(), &fakePublisher{})

	rec, first := postSwipe(t, router, `{"employeeId":"E1","gateId":"GATE_1","direction":"IN"}`)
	if rec.Code != http.StatusOK || first.Decision != DecisionGranted || first.Reason != ReasonAccessAllowed {
		t.Fatalf("first IN = status %d %+v", rec.Code, first)
	}
	if !first.EventBuffered || !first.KafkaQueued {
		t.Fatalf("first IN should buffer and queue event: %+v", first)
	}

	rec, second := postSwipe(t, router, `{"employeeId":"E1","gateId":"GATE_1","direction":"IN"}`)
	if rec.Code != http.StatusOK || second.Decision != DecisionDenied || second.Reason != ReasonAntiPassbackViolation {
		t.Fatalf("second IN = status %d %+v", rec.Code, second)
	}
}

func TestDurationToLatencyMsRoundsUpSubMillisecondDurations(t *testing.T) {
	tests := []struct {
		name     string
		duration time.Duration
		want     int64
	}{
		{name: "zero", duration: 0, want: 0},
		{name: "sub millisecond", duration: 500 * time.Microsecond, want: 1},
		{name: "whole millisecond", duration: time.Millisecond, want: 1},
		{name: "partial next millisecond", duration: 1500 * time.Microsecond, want: 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := durationToLatencyMs(tt.duration); got != tt.want {
				t.Fatalf("durationToLatencyMs(%s) = %d, want %d", tt.duration, got, tt.want)
			}
		})
	}
}

func TestSwipeOutWithoutEntryIsDenied(t *testing.T) {
	router := setupTestRouter(newFakeStore(), &fakePublisher{})

	rec, response := postSwipe(t, router, `{"employeeId":"E1","gateId":"GATE_1","direction":"OUT"}`)
	if rec.Code != http.StatusOK || response.Decision != DecisionDenied || response.Reason != ReasonNoEntryRecord {
		t.Fatalf("OUT without entry = status %d %+v", rec.Code, response)
	}
}

func TestSwipeCacheUnavailable(t *testing.T) {
	store := newFakeStore()
	store.failDecide = true
	router := setupTestRouter(store, &fakePublisher{})

	rec, response := postSwipe(t, router, `{"employeeId":"E1","gateId":"GATE_1","direction":"IN"}`)
	if rec.Code != http.StatusServiceUnavailable || response.Decision != DecisionDenied {
		t.Fatalf("cache unavailable = status %d %+v", rec.Code, response)
	}
}

func TestSwipePublisherFailureDoesNotFailDecision(t *testing.T) {
	publisher := &fakePublisher{publishErr: errPublisherQueueFull}
	router := setupTestRouter(newFakeStore(), publisher)

	rec, response := postSwipe(t, router, `{"employeeId":"E1","gateId":"GATE_1","direction":"IN"}`)
	if rec.Code != http.StatusOK || response.Decision != DecisionGranted {
		t.Fatalf("publisher failure response = status %d %+v", rec.Code, response)
	}
	if response.KafkaQueued {
		t.Fatalf("KafkaQueued = true, want false when publisher returns an error")
	}
}

func TestSwipeBufferFailureStillReturnsDecision(t *testing.T) {
	store := newFakeStore()
	store.failAppendEvent = true
	router := setupTestRouter(store, &fakePublisher{})

	rec, response := postSwipe(t, router, `{"employeeId":"E1","gateId":"GATE_1","direction":"IN"}`)
	if rec.Code != http.StatusOK || response.Decision != DecisionGranted {
		t.Fatalf("buffer failure response = status %d %+v", rec.Code, response)
	}
	if response.EventBuffered {
		t.Fatalf("EventBuffered = true, want false when Redis buffering fails")
	}
}

func TestHealthzReportsStoreAndPublisherFailures(t *testing.T) {
	t.Run("store unavailable", func(t *testing.T) {
		store := newFakeStore()
		store.failPing = true
		router := setupTestRouter(store, &fakePublisher{})

		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "redis") {
			t.Fatalf("healthz store failure = status %d body %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("publisher unavailable", func(t *testing.T) {
		router := setupTestRouter(newFakeStore(), &fakePublisher{healthErr: errors.New("kafka down")})

		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "kafka down") {
			t.Fatalf("healthz publisher failure = status %d body %s", rec.Code, rec.Body.String())
		}
	})
}

func TestStateResetAndEventsEndpoints(t *testing.T) {
	store := newFakeStore()
	store.states["E1"] = DirectionIn
	store.listEvents = []EventDTO{
		{ID: "1-0", Fields: map[string]string{"requestId": "REQ-1"}},
		{ID: "2-0", Fields: map[string]string{"requestId": "REQ-2"}},
	}
	router := setupTestRouter(store, &fakePublisher{})

	req := httptest.NewRequest(http.MethodGet, "/api/access/state/E1", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), DirectionIn) {
		t.Fatalf("get state = status %d body %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/access/reset/E1", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || store.states["E1"] != "" {
		t.Fatalf("reset state = status %d state %q", rec.Code, store.states["E1"])
	}

	req = httptest.NewRequest(http.MethodGet, "/api/access/events?limit=1", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "REQ-1") || strings.Contains(rec.Body.String(), "REQ-2") {
		t.Fatalf("list events limit = status %d body %s", rec.Code, rec.Body.String())
	}
}

func TestStateResetAndEventsFailures(t *testing.T) {
	tests := []struct {
		name  string
		path  string
		setup func(*fakeStore)
	}{
		{name: "get state", path: "/api/access/state/E1", setup: func(s *fakeStore) { s.failGetState = true }},
		{name: "reset state", path: "/api/access/reset/E1", setup: func(s *fakeStore) { s.failResetState = true }},
		{name: "list events", path: "/api/access/events", setup: func(s *fakeStore) { s.failListEvents = true }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			tt.setup(store)
			router := setupTestRouter(store, &fakePublisher{})

			method := http.MethodGet
			if strings.Contains(tt.path, "reset") {
				method = http.MethodPost
			}
			req := httptest.NewRequest(method, tt.path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("%s failure status = %d, want %d", tt.name, rec.Code, http.StatusServiceUnavailable)
			}
		})
	}
}

func TestMetricsIncludeSwipeAndPublisherCounters(t *testing.T) {
	publisher := &fakePublisher{}
	router := setupTestRouter(newFakeStore(), publisher)

	postSwipe(t, router, `{"employeeId":"E1","gateId":"GATE_1","direction":"IN"}`)
	postSwipe(t, router, `{"employeeId":"E1","gateId":"GATE_1","direction":"IN"}`)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	body := rec.Body.String()
	for _, expected := range []string{
		"access_api_swipes_total 2",
		"access_api_swipes_granted_total 1",
		"access_api_swipes_denied_total 1",
		"access_api_events_queued_total 2",
		"access_api_events_buffered_total 2",
		"access_api_events_published_total 2",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("metrics missing %q in:\n%s", expected, body)
		}
	}
}
