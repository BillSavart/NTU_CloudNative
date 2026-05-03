package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Config struct {
	BaseURL        string
	Employees      int
	EmployeePrefix string
	Gates          int
	Duration       time.Duration
	TimeScale      float64
	Workers        int
	Seed           int64
	EntryRatio     float64
	DuplicatePct   float64
	HTTPTimeout    time.Duration
}

type SwipeRequest struct {
	EmployeeID string `json:"employeeId"`
	GateID     string `json:"gateId"`
	Direction  string `json:"direction"`
}

type SwipeResponse struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

type ScheduledSwipe struct {
	At      time.Duration
	Request SwipeRequest
}

type Result struct {
	Status   int
	Decision string
	Reason   string
	Err      error
	Latency  time.Duration
}

type Stats struct {
	Total          atomic.Int64
	Granted        atomic.Int64
	Denied         atomic.Int64
	Errors         atomic.Int64
	AntiPassback   atomic.Int64
	NoEntryRecord  atomic.Int64
	LatencyTotalUs atomic.Int64
	LatencyMaxUs   atomic.Int64
}

func main() {
	cfg := parseFlags()
	rng := rand.New(rand.NewSource(cfg.Seed))

	swipes := buildSchedule(cfg, rng)
	log.Printf("simulating %d swipes: employees=%d gates=%d simulatedDuration=%s timeScale=%.2fx workers=%d",
		len(swipes), cfg.Employees, cfg.Gates, cfg.Duration, cfg.TimeScale, cfg.Workers)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	jobs := make(chan SwipeRequest, cfg.Workers*4)
	results := make(chan Result, cfg.Workers*4)

	client := &http.Client{Timeout: cfg.HTTPTimeout}
	var wg sync.WaitGroup
	for workerID := 0; workerID < cfg.Workers; workerID++ {
		wg.Add(1)
		go worker(ctx, &wg, client, cfg.BaseURL, jobs, results)
	}

	statsDone := make(chan Stats)
	go collectStats(results, statsDone)

	start := time.Now()
	for _, swipe := range swipes {
		waitUntil(start, swipe.At, cfg.TimeScale)
		jobs <- swipe.Request
	}
	close(jobs)

	wg.Wait()
	close(results)
	stats := <-statsDone

	elapsed := time.Since(start)
	printSummary(stats, len(swipes), elapsed, cfg)
}

func parseFlags() Config {
	cfg := Config{}
	flag.StringVar(&cfg.BaseURL, "base-url", envString("ACCESS_API_URL", "http://127.0.0.1:8080"), "Access API base URL")
	flag.IntVar(&cfg.Employees, "employees", envInt("SIM_EMPLOYEES", 90000), "number of employees to simulate")
	flag.StringVar(&cfg.EmployeePrefix, "employee-prefix", envString("SIM_EMPLOYEE_PREFIX", "E"), "employee ID prefix")
	flag.IntVar(&cfg.Gates, "gates", envInt("SIM_GATES", 50), "number of gates")
	flag.DurationVar(&cfg.Duration, "duration", envDuration("SIM_DURATION", 30*time.Minute), "simulated peak duration")
	flag.Float64Var(&cfg.TimeScale, "time-scale", envFloat("SIM_TIME_SCALE", 60), "simulation speedup; 60 means 30 simulated minutes run in 30 real seconds")
	flag.IntVar(&cfg.Workers, "workers", envInt("SIM_WORKERS", 200), "concurrent HTTP workers")
	flag.Int64Var(&cfg.Seed, "seed", envInt64("SIM_SEED", time.Now().UnixNano()), "random seed")
	flag.Float64Var(&cfg.EntryRatio, "entry-ratio", envFloat("SIM_ENTRY_RATIO", 0.97), "ratio of first swipes that are IN")
	flag.Float64Var(&cfg.DuplicatePct, "duplicate-pct", envFloat("SIM_DUPLICATE_PCT", 0.03), "extra duplicate swipes as a fraction of employee count")
	flag.DurationVar(&cfg.HTTPTimeout, "http-timeout", envDuration("SIM_HTTP_TIMEOUT", 3*time.Second), "per-request timeout")
	flag.Parse()

	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.Employees <= 0 {
		fail("employees must be > 0")
	}
	cfg.EmployeePrefix = strings.TrimSpace(cfg.EmployeePrefix)
	if cfg.EmployeePrefix == "" {
		fail("employee-prefix must not be empty")
	}
	if cfg.Gates <= 0 {
		fail("gates must be > 0")
	}
	if cfg.Duration <= 0 {
		fail("duration must be > 0")
	}
	if cfg.TimeScale <= 0 {
		fail("time-scale must be > 0")
	}
	if cfg.Workers <= 0 {
		fail("workers must be > 0")
	}
	if cfg.EntryRatio < 0 || cfg.EntryRatio > 1 {
		fail("entry-ratio must be between 0 and 1")
	}
	if cfg.DuplicatePct < 0 {
		fail("duplicate-pct must be >= 0")
	}

	return cfg
}

func buildSchedule(cfg Config, rng *rand.Rand) []ScheduledSwipe {
	total := cfg.Employees + int(math.Round(float64(cfg.Employees)*cfg.DuplicatePct))
	swipes := make([]ScheduledSwipe, 0, total)

	for i := 1; i <= cfg.Employees; i++ {
		direction := "IN"
		if rng.Float64() > cfg.EntryRatio {
			direction = "OUT"
		}

		swipes = append(swipes, ScheduledSwipe{
			At: gaussianPeakOffset(cfg.Duration, rng),
			Request: SwipeRequest{
				EmployeeID: employeeID(cfg.EmployeePrefix, i),
				GateID:     gateID(rng.Intn(cfg.Gates) + 1),
				Direction:  direction,
			},
		})
	}

	duplicates := total - cfg.Employees
	for i := 0; i < duplicates; i++ {
		employeeNum := rng.Intn(cfg.Employees) + 1
		swipes = append(swipes, ScheduledSwipe{
			At: gaussianPeakOffset(cfg.Duration, rng),
			Request: SwipeRequest{
				EmployeeID: employeeID(cfg.EmployeePrefix, employeeNum),
				GateID:     gateID(rng.Intn(cfg.Gates) + 1),
				Direction:  "IN",
			},
		})
	}

	sortSchedule(swipes)
	return swipes
}

func gaussianPeakOffset(duration time.Duration, rng *rand.Rand) time.Duration {
	center := float64(duration) * 0.45
	stddev := float64(duration) / 6
	for {
		offset := rng.NormFloat64()*stddev + center
		if offset >= 0 && offset <= float64(duration) {
			return time.Duration(offset)
		}
	}
}

func sortSchedule(swipes []ScheduledSwipe) {
	sort.Slice(swipes, func(i, j int) bool {
		return swipes[i].At < swipes[j].At
	})
}

func worker(ctx context.Context, wg *sync.WaitGroup, client *http.Client, baseURL string, jobs <-chan SwipeRequest, results chan<- Result) {
	defer wg.Done()
	for req := range jobs {
		select {
		case <-ctx.Done():
			return
		default:
			results <- sendSwipe(client, baseURL, req)
		}
	}
}

func sendSwipe(client *http.Client, baseURL string, swipe SwipeRequest) Result {
	body, err := json.Marshal(swipe)
	if err != nil {
		return Result{Err: err}
	}

	start := time.Now()
	resp, err := client.Post(baseURL+"/api/access/swipe", "application/json", bytes.NewReader(body))
	latency := time.Since(start)
	if err != nil {
		return Result{Err: err, Latency: latency}
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return Result{Status: resp.StatusCode, Err: err, Latency: latency}
	}

	var swipeResp SwipeResponse
	if err := json.Unmarshal(payload, &swipeResp); err != nil {
		return Result{Status: resp.StatusCode, Err: err, Latency: latency}
	}

	return Result{
		Status:   resp.StatusCode,
		Decision: swipeResp.Decision,
		Reason:   swipeResp.Reason,
		Latency:  latency,
	}
}

func collectStats(results <-chan Result, done chan<- Stats) {
	var stats Stats
	for result := range results {
		stats.Total.Add(1)

		latencyUs := result.Latency.Microseconds()
		stats.LatencyTotalUs.Add(latencyUs)
		updateMax(&stats.LatencyMaxUs, latencyUs)

		if result.Err != nil || result.Status < 200 || result.Status >= 300 {
			stats.Errors.Add(1)
			continue
		}

		switch result.Decision {
		case "GRANTED":
			stats.Granted.Add(1)
		case "DENIED":
			stats.Denied.Add(1)
		}

		switch result.Reason {
		case "ANTI_PASSBACK_VIOLATION":
			stats.AntiPassback.Add(1)
		case "NO_ENTRY_RECORD":
			stats.NoEntryRecord.Add(1)
		}
	}
	done <- stats
}

func updateMax(current *atomic.Int64, candidate int64) {
	for {
		old := current.Load()
		if candidate <= old {
			return
		}
		if current.CompareAndSwap(old, candidate) {
			return
		}
	}
}

func waitUntil(start time.Time, simulatedAt time.Duration, timeScale float64) {
	target := start.Add(time.Duration(float64(simulatedAt) / timeScale))
	if sleep := time.Until(target); sleep > 0 {
		time.Sleep(sleep)
	}
}

func printSummary(stats Stats, scheduled int, elapsed time.Duration, cfg Config) {
	total := stats.Total.Load()
	avgLatencyUs := int64(0)
	if total > 0 {
		avgLatencyUs = stats.LatencyTotalUs.Load() / total
	}

	fmt.Println()
	fmt.Println("Swipe simulation summary")
	fmt.Println("------------------------")
	fmt.Printf("API:                 %s\n", cfg.BaseURL)
	fmt.Printf("Scheduled swipes:    %d\n", scheduled)
	fmt.Printf("Completed swipes:    %d\n", total)
	fmt.Printf("Granted:             %d\n", stats.Granted.Load())
	fmt.Printf("Denied:              %d\n", stats.Denied.Load())
	fmt.Printf("Errors:              %d\n", stats.Errors.Load())
	fmt.Printf("Anti-passback:       %d\n", stats.AntiPassback.Load())
	fmt.Printf("No entry record:     %d\n", stats.NoEntryRecord.Load())
	fmt.Printf("Average latency:     %.2f ms\n", float64(avgLatencyUs)/1000)
	fmt.Printf("Max latency:         %.2f ms\n", float64(stats.LatencyMaxUs.Load())/1000)
	fmt.Printf("Real elapsed time:   %s\n", elapsed.Round(time.Millisecond))
	fmt.Printf("Real request rate:   %.2f req/s\n", float64(total)/elapsed.Seconds())
	fmt.Printf("Simulated peak span: %s\n", cfg.Duration)
}

func employeeID(prefix string, num int) string {
	return fmt.Sprintf("%s%06d", prefix, num)
}

func gateID(num int) string {
	return fmt.Sprintf("GATE_%02d", num)
}

func envString(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt64(key string, fallback int64) int64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func envFloat(key string, fallback float64) float64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func fail(message string) {
	log.Print(message)
	os.Exit(2)
}
