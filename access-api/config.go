package main

import (
	"os"
	"strconv"
)

type Config struct {
	Port           string
	RedisAddr      string
	RedisPassword  string
	RedisDB        int
	StateKeyPrefix string
	EventStreamKey string
}

func LoadConfig() Config {
	return Config{
		Port:           getEnv("PORT", "8080"),
		RedisAddr:      getEnv("REDIS_ADDR", "localhost:6379"),
		RedisPassword:  os.Getenv("REDIS_PASSWORD"),
		RedisDB:        getEnvInt("REDIS_DB", 0),
		StateKeyPrefix: getEnv("STATE_KEY_PREFIX", "access:state:"),
		EventStreamKey: getEnv("EVENT_STREAM_KEY", "access:events"),
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
