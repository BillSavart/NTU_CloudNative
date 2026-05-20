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

	"github.com/gin-gonic/gin"
)

type fakeStore struct {
	mu              sync.Mutex
	states          map[string]string
	events          []AccessEvent
	failPing        bool
	failDecide      bool
	failAppendEvent bool
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
	s.mu.Lock()
	defer s.mu.Unlock()

	state, exists := s.states[employeeID]
	if !exists {
		return "UNKNOWN", false, nil
	}
	return state, true, nil
}

func (s *fakeStore) ResetState(ctx context.Context, employeeID string) error {
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
	return []EventDTO{}, nil
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
	api.POST("/reset/:employeeId", app.ResetState)
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
