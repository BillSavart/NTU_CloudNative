package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const decideAccessScript = `
local current = redis.call("GET", KEYS[1])
local direction = ARGV[1]

if not current then
	if direction == "IN" then
		redis.call("SET", KEYS[1], "IN")
		return {1, "UNKNOWN", "IN", "ACCESS_ALLOWED"}
	end
	return {0, "UNKNOWN", "UNKNOWN", "NO_ENTRY_RECORD"}
end

if current == direction then
	return {0, current, current, "ANTI_PASSBACK_VIOLATION"}
end

if current == "IN" and direction == "OUT" then
	redis.call("SET", KEYS[1], "OUT")
	return {1, current, "OUT", "ACCESS_ALLOWED"}
end

if current == "OUT" and direction == "IN" then
	redis.call("SET", KEYS[1], "IN")
	return {1, current, "IN", "ACCESS_ALLOWED"}
end

return {0, current, current, "ANTI_PASSBACK_VIOLATION"}
`

type RedisStore struct {
	client redis.UniversalClient
	cfg    Config
}

func NewRedisStore(ctx context.Context, cfg Config) (*RedisStore, error) {
	var client redis.UniversalClient
	if cfg.RedisMasterName != "" && len(cfg.RedisSentinels) > 0 {
		client = redis.NewFailoverClient(&redis.FailoverOptions{
			MasterName:    cfg.RedisMasterName,
			SentinelAddrs: cfg.RedisSentinels,
			Password:      cfg.RedisPassword,
			DB:            cfg.RedisDB,
		})
	} else {
		client = redis.NewClient(&redis.Options{
			Addr:     cfg.RedisAddr,
			Password: cfg.RedisPassword,
			DB:       cfg.RedisDB,
		})
	}

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, err
	}

	return &RedisStore{client: client, cfg: cfg}, nil
}

func (s *RedisStore) Close() error {
	return s.client.Close()
}

func (s *RedisStore) Ping(ctx context.Context) error {
	return s.client.Ping(ctx).Err()
}

func (s *RedisStore) DecideAccess(ctx context.Context, employeeID, direction string) (AccessDecision, error) {
	key := s.stateKey(employeeID)
	result, err := s.client.Eval(ctx, decideAccessScript, []string{key}, direction).Result()
	if err != nil {
		return AccessDecision{}, err
	}

	values, ok := result.([]interface{})
	if !ok || len(values) != 4 {
		return AccessDecision{}, fmt.Errorf("unexpected redis script response: %v", result)
	}

	granted, err := strconv.ParseInt(fmt.Sprint(values[0]), 10, 64)
	if err != nil {
		return AccessDecision{}, err
	}

	return AccessDecision{
		Granted:       granted == 1,
		PreviousState: fmt.Sprint(values[1]),
		CurrentState:  fmt.Sprint(values[2]),
		Reason:        fmt.Sprint(values[3]),
	}, nil
}

func (s *RedisStore) GetState(ctx context.Context, employeeID string) (string, bool, error) {
	state, err := s.client.Get(ctx, s.stateKey(employeeID)).Result()
	if err == redis.Nil {
		return "UNKNOWN", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return state, true, nil
}

func (s *RedisStore) ResetState(ctx context.Context, employeeID string) error {
	return s.client.Del(ctx, s.stateKey(employeeID)).Err()
}

func (s *RedisStore) AppendEvent(ctx context.Context, event AccessEvent) error {
	return s.client.XAdd(ctx, &redis.XAddArgs{
		Stream: s.cfg.EventStreamKey,
		Values: map[string]interface{}{
			"requestId":     event.RequestID,
			"employeeId":    event.EmployeeID,
			"gateId":        event.GateID,
			"direction":     event.Direction,
			"decision":      event.Decision,
			"reason":        event.Reason,
			"previousState": event.PreviousState,
			"currentState":  event.CurrentState,
			"latencyMs":     event.LatencyMs,
			"timestamp":     event.Timestamp.Format(time.RFC3339Nano),
		},
	}).Err()
}

func (s *RedisStore) ListEvents(ctx context.Context, limit int64) ([]EventDTO, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	events, err := s.client.XRevRangeN(ctx, s.cfg.EventStreamKey, "+", "-", limit).Result()
	if err != nil {
		return nil, err
	}

	response := make([]EventDTO, 0, len(events))
	for _, event := range events {
		fields := make(map[string]string, len(event.Values))
		for key, value := range event.Values {
			fields[key] = fmt.Sprint(value)
		}
		response = append(response, EventDTO{ID: event.ID, Fields: fields})
	}
	return response, nil
}

func (s *RedisStore) stateKey(employeeID string) string {
	return s.cfg.StateKeyPrefix + employeeID
}
