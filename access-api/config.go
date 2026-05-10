package main

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port                  string
	RedisAddr             string
	RedisSentinels        []string
	RedisMasterName       string
	RedisPassword         string
	RedisDB               int
	StateKeyPrefix        string
	EventStreamKey        string
	EventDedupeKeyPrefix  string
	EventDedupeTTLSeconds int
	KafkaBrokers          []string
	KafkaTopic            string
	PublisherAsync        bool
	PublisherQueue        int
	PublisherWorkers      int
	PublisherBatch        int
	PublisherFlush        int
	PublisherRetryInitial int
	PublisherRetryMax     int
}

func LoadConfig() Config {
	return Config{
		Port:                  getEnv("PORT", "8080"),
		RedisAddr:             getEnv("REDIS_ADDR", "localhost:6379"),
		RedisSentinels:        getEnvCSV("REDIS_SENTINEL_ADDRS", ""),
		RedisMasterName:       getEnv("REDIS_MASTER_NAME", ""),
		RedisPassword:         os.Getenv("REDIS_PASSWORD"),
		RedisDB:               getEnvInt("REDIS_DB", 0),
		StateKeyPrefix:        getEnv("STATE_KEY_PREFIX", "access:state:"),
		EventStreamKey:        getEnv("EVENT_STREAM_KEY", "access:events"),
		EventDedupeKeyPrefix:  getEnv("EVENT_DEDUPE_KEY_PREFIX", "access:event-buffered:"),
		EventDedupeTTLSeconds: getEnvInt("EVENT_DEDUPE_TTL_SECONDS", 86400),
		KafkaBrokers:          getEnvCSV("KAFKA_BROKERS", "localhost:19092,localhost:29092,localhost:39092"),
		KafkaTopic:            getEnv("KAFKA_TOPIC", "access-events"),
		PublisherAsync:        getEnvBool("PUBLISHER_ASYNC", true),
		PublisherQueue:        getEnvInt("PUBLISHER_QUEUE_SIZE", 100000),
		PublisherWorkers:      getEnvInt("PUBLISHER_WORKERS", 8),
		PublisherBatch:        getEnvInt("PUBLISHER_BATCH_SIZE", 100),
		PublisherFlush:        getEnvInt("PUBLISHER_FLUSH_MS", 10),
		PublisherRetryInitial: getEnvInt("PUBLISHER_RETRY_INITIAL_MS", 100),
		PublisherRetryMax:     getEnvInt("PUBLISHER_RETRY_MAX_MS", 5000),
	}
}

func getEnv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func getEnvInt(key string, fallback int) int {
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

func getEnvBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}

	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getEnvCSV(key, fallback string) []string {
	value, exists := os.LookupEnv(key)
	if !exists {
		value = fallback
	}
	parts := strings.Split(value, ",")
	items := make([]string, 0, len(parts))
	for _, part := range parts {
		item := strings.TrimSpace(part)
		if item != "" {
			items = append(items, item)
		}
	}
	return items
}
