package main

// Real-Redis tests for the two Lua scripts that are the system's core trust
// point: decideAccessScript (anti-passback state machine) and
// appendEventOnceScript (exactly-once event buffering).
//
// The fakeStore unit tests in handlers_test.go reimplement this logic in Go and
// therefore prove nothing about the actual Lua, its Redis atomicity semantics,
// or the dedup/state TTLs. These tests run the real scripts against a real Redis
// and are skipped unless TEST_REDIS_ADDR is set, mirroring the env-driven
// dual-mode approach used for the PostgreSQL tests (TEST_DATABASE_URL).
//
//   TEST_REDIS_ADDR=127.0.0.1:6379 TEST_REDIS_PASSWORD=... go test ./...

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var testKeyCounter atomic.Int64

// newTestRedisStore connects to the real Redis named by TEST_REDIS_ADDR and
// returns a store whose keys are uniquely namespaced per test so that parallel
// runs and a shared (e.g. compose) Redis never collide. All keys it creates are
// removed on cleanup; it never issues FLUSHDB so it is safe against a Redis that
// holds other data.
func newTestRedisStore(t *testing.T) *RedisStore {
	t.Helper()

	addr := os.Getenv("TEST_REDIS_ADDR")
	if addr == "" {
		t.Skip("set TEST_REDIS_ADDR to a real Redis to exercise the Lua scripts")
	}

	suffix := fmt.Sprintf("%d-%d-%d", os.Getpid(), time.Now().UnixNano(), testKeyCounter.Add(1))
	cfg := Config{
		RedisAddr:             addr,
		RedisPassword:         os.Getenv("TEST_REDIS_PASSWORD"),
		RedisDB:               getEnvInt("TEST_REDIS_DB", 0),
		StateKeyPrefix:        "test:state:" + suffix + ":",
		StateTTLSeconds:       172800,
		EventStreamKey:        "test:events:" + suffix,
		EventStreamMaxLen:     1000000,
		EventDedupeKeyPrefix:  "test:dedupe:" + suffix + ":",
		EventDedupeTTLSeconds: 86400,
	}

	store, err := NewRedisStore(context.Background(), cfg)
	if err != nil {
		t.Fatalf("connect to test redis at %s: %v", addr, err)
	}

	t.Cleanup(func() {
		cleanupTestKeys(t, store, suffix)
		_ = store.Close()
	})
	return store
}

func cleanupTestKeys(t *testing.T, store *RedisStore, suffix string) {
	t.Helper()
	ctx := context.Background()
	for _, pattern := range []string{
		"test:state:" + suffix + ":*",
		"test:dedupe:" + suffix + ":*",
		"test:events:" + suffix,
	} {
		iter := store.client.Scan(ctx, 0, pattern, 100).Iterator()
		var keys []string
		for iter.Next(ctx) {
			keys = append(keys, iter.Val())
		}
		if len(keys) > 0 {
			_ = store.client.Del(ctx, keys...).Err()
		}
	}
}

func testEvent(requestID, employeeID string) AccessEvent {
	return AccessEvent{
		RequestID:     requestID,
		EmployeeID:    employeeID,
		GateID:        "GATE_1",
		Direction:     DirectionIn,
		Decision:      DecisionGranted,
		Reason:        ReasonAccessAllowed,
		PreviousState: "UNKNOWN",
		CurrentState:  DirectionIn,
		LatencyMs:     1,
		Timestamp:     time.Now().UTC(),
	}
}

// TestDecideAccessScriptAntiPassbackTransitions drives the real Lua state
// machine through every transition and asserts the exact decision tuple.
func TestDecideAccessScriptAntiPassbackTransitions(t *testing.T) {
	store := newTestRedisStore(t)
	ctx := context.Background()
	const emp = "E_TRANS"

	// OUT before any entry: denied, state stays UNKNOWN.
	if d, err := store.DecideAccess(ctx, emp, DirectionOut); err != nil {
		t.Fatalf("OUT decide: %v", err)
	} else if d.Granted || d.Reason != ReasonNoEntryRecord || d.CurrentState != "UNKNOWN" {
		t.Fatalf("OUT without entry = %+v, want denied NO_ENTRY_RECORD", d)
	}

	// First IN: granted, UNKNOWN -> IN.
	if d, err := store.DecideAccess(ctx, emp, DirectionIn); err != nil {
		t.Fatalf("IN decide: %v", err)
	} else if !d.Granted || d.PreviousState != "UNKNOWN" || d.CurrentState != DirectionIn || d.Reason != ReasonAccessAllowed {
		t.Fatalf("first IN = %+v, want granted UNKNOWN->IN", d)
	}

	// Second IN: anti-passback violation, state unchanged.
	if d, err := store.DecideAccess(ctx, emp, DirectionIn); err != nil {
		t.Fatalf("double IN decide: %v", err)
	} else if d.Granted || d.Reason != ReasonAntiPassbackViolation || d.CurrentState != DirectionIn {
		t.Fatalf("double IN = %+v, want denied ANTI_PASSBACK_VIOLATION", d)
	}

	// OUT: granted, IN -> OUT.
	if d, err := store.DecideAccess(ctx, emp, DirectionOut); err != nil {
		t.Fatalf("OUT decide: %v", err)
	} else if !d.Granted || d.PreviousState != DirectionIn || d.CurrentState != DirectionOut {
		t.Fatalf("OUT = %+v, want granted IN->OUT", d)
	}

	// Second OUT: anti-passback violation.
	if d, err := store.DecideAccess(ctx, emp, DirectionOut); err != nil {
		t.Fatalf("double OUT decide: %v", err)
	} else if d.Granted || d.Reason != ReasonAntiPassbackViolation {
		t.Fatalf("double OUT = %+v, want denied ANTI_PASSBACK_VIOLATION", d)
	}
}

// TestDecideAccessScriptSetsStateTTL verifies the script applies EX <ttl> when
// StateTTLSeconds > 0 (so stuck states self-clear, defect #4) and leaves the key
// persistent when StateTTLSeconds == 0.
func TestDecideAccessScriptSetsStateTTL(t *testing.T) {
	store := newTestRedisStore(t)
	ctx := context.Background()

	store.cfg.StateTTLSeconds = 120
	const empTTL = "E_TTL"
	if _, err := store.DecideAccess(ctx, empTTL, DirectionIn); err != nil {
		t.Fatalf("IN decide: %v", err)
	}
	ttl, err := store.client.TTL(ctx, store.stateKey(empTTL)).Result()
	if err != nil {
		t.Fatalf("TTL: %v", err)
	}
	if ttl <= 0 || ttl > 120*time.Second {
		t.Fatalf("state TTL = %s, want (0, 120s]", ttl)
	}

	store.cfg.StateTTLSeconds = 0
	const empNoTTL = "E_NOTTL"
	if _, err := store.DecideAccess(ctx, empNoTTL, DirectionIn); err != nil {
		t.Fatalf("IN decide (no ttl): %v", err)
	}
	ttl, err = store.client.TTL(ctx, store.stateKey(empNoTTL)).Result()
	if err != nil {
		t.Fatalf("TTL (no ttl): %v", err)
	}
	if ttl >= 0 {
		t.Fatalf("state TTL with StateTTLSeconds=0 = %s, want no expiry (<0)", ttl)
	}
}

// TestAppendEventOnceDeduplicates proves the SET NX dedup gate keeps the stream
// at exactly one entry for a repeated requestId, and sets the dedup key TTL.
func TestAppendEventOnceDeduplicates(t *testing.T) {
	store := newTestRedisStore(t)
	ctx := context.Background()

	event := testEvent("req-dedupe", "E_DUP")
	for i := 0; i < 3; i++ {
		if err := store.AppendEventOnce(ctx, event); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	events, err := store.ListEvents(ctx, 100)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("stream length = %d, want 1 (deduplicated)", len(events))
	}
	if events[0].Fields["requestId"] != "req-dedupe" {
		t.Fatalf("stream entry requestId = %q, want req-dedupe", events[0].Fields["requestId"])
	}

	ttl, err := store.client.TTL(ctx, store.cfg.EventDedupeKeyPrefix+"req-dedupe").Result()
	if err != nil {
		t.Fatalf("dedupe TTL: %v", err)
	}
	if ttl <= 0 {
		t.Fatalf("dedupe key TTL = %s, want > 0", ttl)
	}
}

// TestAppendEventOnceConcurrentExactlyOnce hammers the same requestId from many
// goroutines. The SET NX inside the Lua script must let exactly one writer reach
// XADD, so the stream ends with a single entry no matter the interleaving.
func TestAppendEventOnceConcurrentExactlyOnce(t *testing.T) {
	store := newTestRedisStore(t)
	ctx := context.Background()

	const workers = 50
	event := testEvent("req-race", "E_RACE")

	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := store.AppendEventOnce(ctx, event); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent append error: %v", err)
	}

	events, err := store.ListEvents(ctx, 100)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("stream length = %d, want exactly 1 under %d concurrent identical appends", len(events), workers)
	}
}

// TestDecideAccessConcurrentSingleGrant is the heart of the anti-passback trust
// argument: many gates swipe the same fresh employee IN at once. Because the Lua
// script runs atomically on Redis, exactly one swipe may be granted and the rest
// must be anti-passback violations — the property a non-atomic GET-then-SET would
// break under load.
func TestDecideAccessConcurrentSingleGrant(t *testing.T) {
	store := newTestRedisStore(t)
	ctx := context.Background()
	const emp = "E_CONC"
	const workers = 100

	var granted atomic.Int64
	var violations atomic.Int64
	var wg sync.WaitGroup
	errs := make(chan error, workers)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d, err := store.DecideAccess(ctx, emp, DirectionIn)
			if err != nil {
				errs <- err
				return
			}
			if d.Granted {
				granted.Add(1)
			} else if d.Reason == ReasonAntiPassbackViolation {
				violations.Add(1)
			} else {
				errs <- fmt.Errorf("unexpected decision %+v", d)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent decide error: %v", err)
	}

	if granted.Load() != 1 {
		t.Fatalf("granted = %d, want exactly 1 concurrent IN granted", granted.Load())
	}
	if violations.Load() != workers-1 {
		t.Fatalf("violations = %d, want %d", violations.Load(), workers-1)
	}

	state, _, err := store.GetState(ctx, emp)
	if err != nil {
		t.Fatalf("get state: %v", err)
	}
	if state != DirectionIn {
		t.Fatalf("final state = %q, want IN", state)
	}
}
