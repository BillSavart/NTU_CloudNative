package main

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
)

type EventPublisher interface {
	Publish(ctx context.Context, event AccessEvent) error
	Health(ctx context.Context) error
	Close() error
	Name() string
}

type RedisEventPublisher struct {
	store *RedisStore
}

func NewEventPublisher(cfg Config, store *RedisStore) EventPublisher {
	if len(cfg.KafkaBrokers) == 0 {
		return &RedisEventPublisher{store: store}
	}
	return &KafkaEventPublisher{
		writer: &kafka.Writer{
			Addr:                   kafka.TCP(cfg.KafkaBrokers...),
			Topic:                  cfg.KafkaTopic,
			Balancer:               &kafka.Hash{},
			RequiredAcks:           kafka.RequireOne,
			AllowAutoTopicCreation: true,
			Async:                  false,
		},
		brokers:     cfg.KafkaBrokers,
		topic:       cfg.KafkaTopic,
		mirrorRedis: cfg.KafkaMirrorRedis,
		store:       store,
	}
}

func (p *RedisEventPublisher) Publish(ctx context.Context, event AccessEvent) error {
	return p.store.AppendEvent(ctx, event)
}

func (p *RedisEventPublisher) Health(ctx context.Context) error {
	return p.store.Ping(ctx)
}

func (p *RedisEventPublisher) Close() error {
	return nil
}

func (p *RedisEventPublisher) Name() string {
	return "redis-stream"
}

type KafkaEventPublisher struct {
	writer      *kafka.Writer
	brokers     []string
	topic       string
	mirrorRedis bool
	store       *RedisStore
}

func (p *KafkaEventPublisher) Publish(ctx context.Context, event AccessEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}

	err = p.writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(event.EmployeeID),
		Value: payload,
		Time:  event.Timestamp,
		Headers: []kafka.Header{
			{Key: "decision", Value: []byte(event.Decision)},
			{Key: "direction", Value: []byte(event.Direction)},
		},
	})
	if err != nil {
		return err
	}

	if p.mirrorRedis {
		return p.store.AppendEvent(ctx, event)
	}
	return nil
}

func (p *KafkaEventPublisher) Health(ctx context.Context) error {
	dialer := &kafka.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", p.brokers[0])
	if err != nil {
		return err
	}
	defer conn.Close()

	_, err = conn.ReadPartitions()
	return err
}

func (p *KafkaEventPublisher) Close() error {
	return p.writer.Close()
}

func (p *KafkaEventPublisher) Name() string {
	return "kafka:" + strings.Join(p.brokers, ",") + "/" + p.topic
}
