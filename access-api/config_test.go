package main

import (
	"reflect"
	"testing"
)

func TestLoadConfigReadsEnvironmentAndFallbacks(t *testing.T) {
	t.Setenv("PORT", "9090")
	t.Setenv("REDIS_ADDR", "redis:6379")
	t.Setenv("REDIS_SENTINEL_ADDRS", "s1:26379, s2:26379,, ")
	t.Setenv("REDIS_MASTER_NAME", "mymaster")
	t.Setenv("REDIS_PASSWORD", "secret")
	t.Setenv("REDIS_DB", "2")
	t.Setenv("STATE_KEY_PREFIX", "state:")
	t.Setenv("STATE_TTL_SECONDS", "60")
	t.Setenv("EVENT_STREAM_KEY", "events")
	t.Setenv("EVENT_STREAM_MAXLEN", "1234")
	t.Setenv("EVENT_DEDUPE_KEY_PREFIX", "dedupe:")
	t.Setenv("EVENT_DEDUPE_TTL_SECONDS", "90")
	t.Setenv("KAFKA_BROKERS", "k1:9092,k2:9092")
	t.Setenv("KAFKA_TOPIC", "topic")
	t.Setenv("PUBLISHER_ASYNC", "false")
	t.Setenv("PUBLISHER_QUEUE_SIZE", "7")
	t.Setenv("PUBLISHER_WORKERS", "3")
	t.Setenv("PUBLISHER_BATCH_SIZE", "4")
	t.Setenv("PUBLISHER_FLUSH_MS", "5")
	t.Setenv("PUBLISHER_RETRY_INITIAL_MS", "6")
	t.Setenv("PUBLISHER_RETRY_MAX_MS", "8")
	t.Setenv("OTEL_SERVICE_NAME", "svc")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://otel/v1/traces")

	cfg := LoadConfig()

	if cfg.Port != "9090" || cfg.RedisAddr != "redis:6379" || cfg.RedisDB != 2 {
		t.Fatalf("basic config not loaded: %+v", cfg)
	}
	if !reflect.DeepEqual(cfg.RedisSentinels, []string{"s1:26379", "s2:26379"}) {
		t.Fatalf("RedisSentinels = %#v", cfg.RedisSentinels)
	}
	if !reflect.DeepEqual(cfg.KafkaBrokers, []string{"k1:9092", "k2:9092"}) {
		t.Fatalf("KafkaBrokers = %#v", cfg.KafkaBrokers)
	}
	if cfg.PublisherAsync {
		t.Fatal("PublisherAsync = true, want false")
	}
	if cfg.EventStreamMaxLen != 1234 || cfg.PublisherQueue != 7 || cfg.PublisherRetryMax != 8 {
		t.Fatalf("numeric config not loaded: %+v", cfg)
	}
	if cfg.OtelTracesEndpoint != "http://otel/v1/traces" {
		t.Fatalf("OtelTracesEndpoint = %q", cfg.OtelTracesEndpoint)
	}
}

func TestEnvHelpersFallbackOnMissingOrInvalidValues(t *testing.T) {
	t.Setenv("BAD_INT", "not-an-int")
	t.Setenv("BAD_INT64", "not-an-int64")
	t.Setenv("BAD_BOOL", "not-bool")
	t.Setenv("EMPTY_CSV", " , , ")

	if got := firstNonEmpty(" ", "", "value"); got != "value" {
		t.Fatalf("firstNonEmpty = %q", got)
	}
	if got := getEnv("MISSING", "fallback"); got != "fallback" {
		t.Fatalf("getEnv missing = %q", got)
	}
	if got := getEnvInt("BAD_INT", 12); got != 12 {
		t.Fatalf("getEnvInt invalid = %d", got)
	}
	if got := getEnvInt64("BAD_INT64", 34); got != 34 {
		t.Fatalf("getEnvInt64 invalid = %d", got)
	}
	if got := getEnvBool("BAD_BOOL", true); !got {
		t.Fatalf("getEnvBool invalid = false, want fallback true")
	}
	if got := getEnvCSV("EMPTY_CSV", "a,b"); len(got) != 0 {
		t.Fatalf("getEnvCSV empty = %#v", got)
	}
}
