package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

type EventPublisher interface {
	Publish(ctx context.Context, event AccessEvent) error
	PublishBatch(ctx context.Context, events []AccessEvent) error
	Health(ctx context.Context) error
	Close() error
	Name() string
	Stats() PublisherStats
}

type PublisherStats struct {
	Queued     atomic.Int64
	Published  atomic.Int64
	Failed     atomic.Int64
	Retried    atomic.Int64
	Dropped    atomic.Int64
	QueueDepth atomic.Int64
}

func NewEventPublisher(cfg Config, store *RedisStore) EventPublisher {
	var publisher EventPublisher
	if len(cfg.KafkaBrokers) == 0 {
		publisher = &RedisEventPublisher{store: store}
	} else {
		publisher = &KafkaEventPublisher{
			writer: &kafka.Writer{
				Addr:                   kafka.TCP(cfg.KafkaBrokers...),
				Topic:                  cfg.KafkaTopic,
				Balancer:               &kafka.Hash{},
				RequiredAcks:           kafka.RequireOne,
				AllowAutoTopicCreation: true,
				Async:                  false,
			},
			brokers: cfg.KafkaBrokers,
			topic:   cfg.KafkaTopic,
		}
	}

	if cfg.PublisherAsync {
		return NewAsyncEventPublisher(
			publisher,
			cfg.PublisherQueue,
			cfg.PublisherWorkers,
			cfg.PublisherBatch,
			time.Duration(cfg.PublisherFlush)*time.Millisecond,
			time.Duration(cfg.PublisherRetryInitial)*time.Millisecond,
			time.Duration(cfg.PublisherRetryMax)*time.Millisecond,
		)
	}
	return publisher
}

type RedisEventPublisher struct {
	store *RedisStore
	stats PublisherStats
}

func (p *RedisEventPublisher) Publish(ctx context.Context, event AccessEvent) error {
	return p.PublishBatch(ctx, []AccessEvent{event})
}

func (p *RedisEventPublisher) PublishBatch(ctx context.Context, events []AccessEvent) error {
	for _, event := range events {
		if err := p.store.AppendEventOnce(ctx, event); err != nil {
			p.stats.Failed.Add(int64(len(events)))
			return err
		}
	}
	p.stats.Published.Add(int64(len(events)))
	return nil
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

func (p *RedisEventPublisher) Stats() PublisherStats {
	return p.stats
}

type KafkaEventPublisher struct {
	writer  *kafka.Writer
	brokers []string
	topic   string
	stats   PublisherStats
}

func (p *KafkaEventPublisher) Publish(ctx context.Context, event AccessEvent) error {
	return p.PublishBatch(ctx, []AccessEvent{event})
}

func (p *KafkaEventPublisher) PublishBatch(ctx context.Context, events []AccessEvent) error {
	if len(events) == 0 {
		return nil
	}

	messages := make([]kafka.Message, 0, len(events))
	for _, event := range events {
		payload, err := json.Marshal(event)
		if err != nil {
			p.stats.Failed.Add(int64(len(events)))
			return err
		}

		messages = append(messages, kafka.Message{
			Key:   []byte(event.EmployeeID),
			Value: payload,
			Time:  event.Timestamp,
			Headers: []kafka.Header{
				{Key: "decision", Value: []byte(event.Decision)},
				{Key: "direction", Value: []byte(event.Direction)},
			},
		})
	}

	if err := p.writer.WriteMessages(ctx, messages...); err != nil {
		p.stats.Failed.Add(int64(len(events)))
		return err
	}

	p.stats.Published.Add(int64(len(events)))
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

func (p *KafkaEventPublisher) Stats() PublisherStats {
	return p.stats
}

type AsyncEventPublisher struct {
	inner        EventPublisher
	queue        chan AccessEvent
	done         chan struct{}
	closed       atomic.Bool
	wg           sync.WaitGroup
	stats        PublisherStats
	batchSize    int
	flushTimeout time.Duration
	retryInitial time.Duration
	retryMax     time.Duration
}

var errPublisherQueueFull = errors.New("event publisher queue is full")

func NewAsyncEventPublisher(inner EventPublisher, queueSize, workers, batchSize int, flushTimeout, retryInitial, retryMax time.Duration) *AsyncEventPublisher {
	if queueSize <= 0 {
		queueSize = 100000
	}
	if workers <= 0 {
		workers = 1
	}
	if batchSize <= 0 {
		batchSize = 100
	}
	if flushTimeout <= 0 {
		flushTimeout = 10 * time.Millisecond
	}
	if retryInitial <= 0 {
		retryInitial = 100 * time.Millisecond
	}
	if retryMax <= 0 {
		retryMax = 5 * time.Second
	}
	if retryMax < retryInitial {
		retryMax = retryInitial
	}

	p := &AsyncEventPublisher{
		inner:        inner,
		queue:        make(chan AccessEvent, queueSize),
		done:         make(chan struct{}),
		batchSize:    batchSize,
		flushTimeout: flushTimeout,
		retryInitial: retryInitial,
		retryMax:     retryMax,
	}

	for i := 0; i < workers; i++ {
		p.wg.Add(1)
		go p.worker(i + 1)
	}
	return p
}

func (p *AsyncEventPublisher) Publish(ctx context.Context, event AccessEvent) error {
	if p.closed.Load() {
		p.stats.Dropped.Add(1)
		return errors.New("event publisher is closed")
	}

	select {
	case p.queue <- event:
		p.stats.Queued.Add(1)
		p.stats.QueueDepth.Store(int64(len(p.queue)))
		return nil
	default:
		p.stats.Dropped.Add(1)
		p.stats.QueueDepth.Store(int64(len(p.queue)))
		return errPublisherQueueFull
	}
}

func (p *AsyncEventPublisher) PublishBatch(ctx context.Context, events []AccessEvent) error {
	for _, event := range events {
		if err := p.Publish(ctx, event); err != nil {
			return err
		}
	}
	return nil
}

func (p *AsyncEventPublisher) Health(ctx context.Context) error {
	return p.inner.Health(ctx)
}

func (p *AsyncEventPublisher) Close() error {
	if !p.closed.CompareAndSwap(false, true) {
		return nil
	}

	close(p.done)
	p.wg.Wait()
	return p.inner.Close()
}

func (p *AsyncEventPublisher) Name() string {
	return "async/" + p.inner.Name()
}

func (p *AsyncEventPublisher) Stats() PublisherStats {
	innerStats := p.inner.Stats()
	var stats PublisherStats
	stats.Queued.Store(p.stats.Queued.Load())
	stats.Published.Store(innerStats.Published.Load())
	stats.Failed.Store(innerStats.Failed.Load())
	stats.Retried.Store(p.stats.Retried.Load())
	stats.Dropped.Store(p.stats.Dropped.Load())
	stats.QueueDepth.Store(int64(len(p.queue)))
	return stats
}

func (p *AsyncEventPublisher) worker(id int) {
	defer p.wg.Done()

	for {
		select {
		case <-p.done:
			p.drain(id)
			return
		case event := <-p.queue:
			batch := p.collectBatch(event)
			p.publishBatchWithRecovery(id, batch)
		}
	}
}

func (p *AsyncEventPublisher) collectBatch(first AccessEvent) []AccessEvent {
	batch := make([]AccessEvent, 0, p.batchSize)
	batch = append(batch, first)

	timer := time.NewTimer(p.flushTimeout)
	defer timer.Stop()

	for len(batch) < p.batchSize {
		select {
		case <-p.done:
			return batch
		case event := <-p.queue:
			batch = append(batch, event)
		case <-timer.C:
			return batch
		}
	}
	return batch
}

func (p *AsyncEventPublisher) drain(workerID int) {
	batch := make([]AccessEvent, 0, p.batchSize)
	for {
		select {
		case event := <-p.queue:
			batch = append(batch, event)
			if len(batch) >= p.batchSize {
				p.publishBatchOnce(workerID, batch)
				batch = make([]AccessEvent, 0, p.batchSize)
			}
		default:
			if len(batch) > 0 {
				p.publishBatchOnce(workerID, batch)
			}
			p.stats.QueueDepth.Store(0)
			return
		}
	}
}

func (p *AsyncEventPublisher) publishBatchWithRecovery(workerID int, events []AccessEvent) {
	if len(events) == 0 {
		return
	}

	backoff := p.retryInitial
	for {
		if p.publishBatchOnce(workerID, events) {
			return
		}

		p.stats.Retried.Add(int64(len(events)))
		select {
		case <-p.done:
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > p.retryMax {
			backoff = p.retryMax
		}
	}
}

func (p *AsyncEventPublisher) publishBatchOnce(workerID int, events []AccessEvent) bool {
	if len(events) == 0 {
		return true
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := p.inner.PublishBatch(ctx, events); err != nil {
		log.Printf("async publisher worker=%d failed batchSize=%d firstRequestId=%s publisher=%s: %v", workerID, len(events), events[0].RequestID, p.inner.Name(), err)
		p.stats.QueueDepth.Store(int64(len(p.queue)))
		return false
	}
	p.stats.QueueDepth.Store(int64(len(p.queue)))
	return true
}
