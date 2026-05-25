package main

import (
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
