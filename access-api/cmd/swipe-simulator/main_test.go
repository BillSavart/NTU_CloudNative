package main

import (
	"errors"
	"math/rand"
	"testing"
	"time"
)

func TestBuildScenarioKeepsPeakProfileWithoutSetup(t *testing.T) {
	cfg := Config{
		Employees:      100,
		EmployeePrefix: "TEST",
		Gates:          5,
		Duration:       time.Minute,
		Profile:        "peak",
		EntryRatio:     1,
		DuplicatePct:   0.05,
	}

	scenario := buildScenario(cfg, rand.New(rand.NewSource(1)))

	if len(scenario.Setup) != 0 {
		t.Fatalf("peak setup swipes = %d, want 0", len(scenario.Setup))
	}
	if len(scenario.Swipes) != 105 {
		t.Fatalf("peak swipes = %d, want 105", len(scenario.Swipes))
	}
}

func TestBuildNormalScenarioPreloadsInitialInsideEmployees(t *testing.T) {
	cfg := Config{
		Employees:      10,
		EmployeePrefix: "TEST",
		Gates:          3,
		Duration:       5 * time.Minute,
		Profile:        "normal",
		InitialInside:  0.3,
		DuplicatePct:   0,
	}

	scenario := buildScenario(cfg, rand.New(rand.NewSource(2)))

	if len(scenario.Setup) != 3 {
		t.Fatalf("normal setup swipes = %d, want 3", len(scenario.Setup))
	}
	if len(scenario.Swipes) != 10 {
		t.Fatalf("normal timed swipes = %d, want 10", len(scenario.Swipes))
	}

	initialInside := map[string]bool{}
	for _, request := range scenario.Setup {
		if request.Direction != "IN" {
			t.Fatalf("setup direction = %s, want IN", request.Direction)
		}
		initialInside[request.EmployeeID] = true
	}

	for _, swipe := range scenario.Swipes {
		if swipe.At < 0 || swipe.At > cfg.Duration {
			t.Fatalf("timed swipe offset = %s, want within %s", swipe.At, cfg.Duration)
		}
		if initialInside[swipe.Request.EmployeeID] && swipe.Request.Direction != "OUT" {
			t.Fatalf("initially inside employee %s direction = %s, want OUT", swipe.Request.EmployeeID, swipe.Request.Direction)
		}
		if !initialInside[swipe.Request.EmployeeID] && swipe.Request.Direction != "IN" {
			t.Fatalf("initially outside employee %s direction = %s, want IN", swipe.Request.EmployeeID, swipe.Request.Direction)
		}
	}
}

func TestOffsetHelpersClampAndGenerateExpectedBounds(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	duration := 10 * time.Second

	for i := 0; i < 100; i++ {
		if got := uniformOffset(duration, rng); got < 0 || got > duration {
			t.Fatalf("uniformOffset = %s, want within [0,%s]", got, duration)
		}
		if got := duplicateOffset(rng); got < 0 || got > 3*time.Second {
			t.Fatalf("duplicateOffset = %s, want within [0,3s]", got)
		}
	}

	if got := clampOffset(-time.Second, duration); got != 0 {
		t.Fatalf("clamp negative = %s, want 0", got)
	}
	if got := clampOffset(11*time.Second, duration); got != duration {
		t.Fatalf("clamp over duration = %s, want %s", got, duration)
	}
	if got := clampOffset(5*time.Second, duration); got != 5*time.Second {
		t.Fatalf("clamp in range = %s, want 5s", got)
	}
}

func TestEnvironmentHelpersUseFallbacksAndParsedValues(t *testing.T) {
	t.Setenv("SIM_STRING", "value")
	t.Setenv("SIM_INT", "42")
	t.Setenv("SIM_INT64", "42000000000")
	t.Setenv("SIM_FLOAT", "0.75")
	t.Setenv("SIM_DURATION", "250ms")
	t.Setenv("SIM_BAD_INT", "bad")
	t.Setenv("SIM_BAD_FLOAT", "bad")
	t.Setenv("SIM_BAD_DURATION", "bad")

	if got := envString("SIM_STRING", "fallback"); got != "value" {
		t.Fatalf("envString = %q", got)
	}
	if got := envString("SIM_MISSING_STRING", "fallback"); got != "fallback" {
		t.Fatalf("envString fallback = %q", got)
	}
	if got := envInt("SIM_INT", 1); got != 42 {
		t.Fatalf("envInt = %d", got)
	}
	if got := envInt("SIM_BAD_INT", 1); got != 1 {
		t.Fatalf("envInt fallback = %d", got)
	}
	if got := envInt64("SIM_INT64", 1); got != 42000000000 {
		t.Fatalf("envInt64 = %d", got)
	}
	if got := envFloat("SIM_FLOAT", 0); got != 0.75 {
		t.Fatalf("envFloat = %f", got)
	}
	if got := envFloat("SIM_BAD_FLOAT", 0.5); got != 0.5 {
		t.Fatalf("envFloat fallback = %f", got)
	}
	if got := envDuration("SIM_DURATION", time.Second); got != 250*time.Millisecond {
		t.Fatalf("envDuration = %s", got)
	}
	if got := envDuration("SIM_BAD_DURATION", time.Second); got != time.Second {
		t.Fatalf("envDuration fallback = %s", got)
	}
}

func TestStatsErrorSnapshotAndClassifyError(t *testing.T) {
	var stats Stats
	stats.recordError(Result{Status: 503})
	stats.recordError(Result{Err: errors.New("Client.Timeout exceeded"), ErrorKey: classifyError(errors.New("Client.Timeout exceeded"))})
	stats.recordError(Result{Err: errors.New("dial tcp: connection refused"), ErrorKey: classifyError(errors.New("dial tcp: connection refused"))})
	stats.recordError(Result{Err: errors.New("connection reset by peer"), ErrorKey: classifyError(errors.New("connection reset by peer"))})
	stats.recordError(Result{Err: errors.New("lookup api: no such host"), ErrorKey: classifyError(errors.New("lookup api: no such host"))})
	stats.recordError(Result{Err: errors.New("other network error"), ErrorKey: classifyError(errors.New("other network error"))})

	lines, samples := stats.errorSnapshot()
	for _, want := range []string{
		"http_status_503: 1",
		"request_timeout: 1",
		"connection_refused: 1",
		"connection_reset: 1",
		"dns_lookup_failed: 1",
		"request_error: 1",
	} {
		found := false
		for _, line := range lines {
			if line == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("errorSnapshot missing %q in %#v", want, lines)
		}
	}
	if len(samples) != 5 {
		t.Fatalf("sample count = %d, want capped at 5", len(samples))
	}
}

func TestCollectStatsCategorizesResults(t *testing.T) {
	results := make(chan Result, 5)
	done := make(chan struct{})
	var stats Stats

	go collectStats(results, &stats, done)
	results <- Result{Status: 200, Decision: "GRANTED", Reason: "ACCESS_ALLOWED", Latency: time.Millisecond}
	results <- Result{Status: 200, Decision: "DENIED", Reason: "ANTI_PASSBACK_VIOLATION", Latency: 2 * time.Millisecond}
	results <- Result{Status: 200, Decision: "DENIED", Reason: "NO_ENTRY_RECORD", Latency: 3 * time.Millisecond}
	results <- Result{Status: 500, Latency: 4 * time.Millisecond}
	results <- Result{Err: errors.New("connection refused"), ErrorKey: "connection_refused", Latency: 5 * time.Millisecond}
	close(results)
	<-done

	if stats.Total.Load() != 5 || stats.Granted.Load() != 1 || stats.Denied.Load() != 2 || stats.Errors.Load() != 2 {
		t.Fatalf("stats counts total=%d granted=%d denied=%d errors=%d", stats.Total.Load(), stats.Granted.Load(), stats.Denied.Load(), stats.Errors.Load())
	}
	if stats.AntiPassback.Load() != 1 || stats.NoEntryRecord.Load() != 1 {
		t.Fatalf("reason counts anti=%d noEntry=%d", stats.AntiPassback.Load(), stats.NoEntryRecord.Load())
	}
	if stats.LatencyMaxUs.Load() != 5000 {
		t.Fatalf("max latency us = %d, want 5000", stats.LatencyMaxUs.Load())
	}
}
