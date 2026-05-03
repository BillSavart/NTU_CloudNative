package main

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port             string
	RedisAddr        string
	RedisPassword    string
	RedisDB          int
	StateKeyPrefix   string
	EventStreamKey   string
	KafkaBrokers     []string
	KafkaTopic       string
	KafkaMirrorRedis bool
}

func LoadConfig() Config {
	return Config{
		Port:             getEnv("PORT", "8080"),
		RedisAddr:        getEnv("REDIS_ADDR", "localhost:6379"),
		RedisPassword:    os.Getenv("REDIS_PASSWORD"),
		RedisDB:          getEnvInt("REDIS_DB", 0),
		StateKeyPrefix:   getEnv("STATE_KEY_PREFIX", "access:state:"),
		EventStreamKey:   getEnv("EVENT_STREAM_KEY", "access:events"),
		KafkaBrokers:     getEnvCSV("KAFKA_BROKERS", "localhost:9092"),
		KafkaTopic:       getEnv("KAFKA_TOPIC", "access-events"),
		KafkaMirrorRedis: getEnvBool("KAFKA_MIRROR_REDIS", true),
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
