package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type flakyPublisher struct {
	mu          sync.Mutex
	failures    int
	published   []AccessEvent
	publishedCh chan struct{}
	stats       PublisherStats
}

type blockingPublisher struct {
	started chan struct{}
	release chan struct{}
	stats   PublisherStats
}

func newBlockingPublisher() *blockingPublisher {
	return &blockingPublisher{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (p *blockingPublisher) Publish(ctx context.Context, event AccessEvent) error {
	return p.PublishBatch(ctx, []AccessEvent{event})
}

func (p *blockingPublisher) PublishBatch(ctx context.Context, events []AccessEvent) error {
	select {
	case <-p.started:
	default:
		close(p.started)
	}
	<-p.release
	p.stats.Published.Add(int64(len(events)))
	return nil
}

func (p *blockingPublisher) Health(ctx context.Context) error {
	return nil
}

func (p *blockingPublisher) Close() error {
	return nil
}

func (p *blockingPublisher) Name() string {
	return "blocking"
}

func (p *blockingPublisher) Stats() PublisherStats {
	return p.stats
}

func newFlakyPublisher(failures int) *flakyPublisher {
	return &flakyPublisher{
		failures:    failures,
		publishedCh: make(chan struct{}),
	}
}

func (p *flakyPublisher) Publish(ctx context.Context, event AccessEvent) error {
	return p.PublishBatch(ctx, []AccessEvent{event})
}

func (p *flakyPublisher) PublishBatch(ctx context.Context, events []AccessEvent) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.failures > 0 {
		p.failures--
		p.stats.Failed.Add(int64(len(events)))
		return errors.New("publisher temporarily unavailable")
	}

	p.published = append(p.published, events...)
	p.stats.Published.Add(int64(len(events)))
	select {
	case <-p.publishedCh:
	default:
		close(p.publishedCh)
	}
	return nil
}

func (p *flakyPublisher) Health(ctx context.Context) error {
	return nil
}

func (p *flakyPublisher) Close() error {
	return nil
}

func (p *flakyPublisher) Name() string {
	return "flaky"
}

func (p *flakyPublisher) Stats() PublisherStats {
	return p.stats
}

func (p *flakyPublisher) publishedCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.published)
}

func TestAsyncPublisherRetriesUntilPublishSucceeds(t *testing.T) {
	inner := newFlakyPublisher(2)
	publisher := NewAsyncEventPublisher(
		inner,
		10,
		1,
		1,
		time.Millisecond,
		time.Millisecond,
		5*time.Millisecond,
	)
	defer publisher.Close()

	event := AccessEvent{
		RequestID:  "REQ-1",
		EmployeeID: "E000001",
		Timestamp:  time.Now().UTC(),
	}
	if err := publisher.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish returned error: %v", err)
	}

	select {
	case <-inner.publishedCh:
	case <-time.After(time.Second):
		t.Fatal("event was not published after retry")
	}

	if got := inner.publishedCount(); got != 1 {
		t.Fatalf("published count = %d, want 1", got)
	}

	stats := publisher.Stats()
	if got := stats.Retried.Load(); got < 2 {
		t.Fatalf("retried events = %d, want at least 2", got)
	}
	if got := stats.Published.Load(); got != 1 {
		t.Fatalf("published events = %d, want 1", got)
	}
}

func TestAsyncPublisherDropsWhenQueueIsFull(t *testing.T) {
	inner := newBlockingPublisher()
	publisher := NewAsyncEventPublisher(
		inner,
		1,
		1,
		1,
		time.Second,
		time.Millisecond,
		time.Millisecond,
	)

	if err := publisher.Publish(context.Background(), AccessEvent{RequestID: "REQ-1"}); err != nil {
		t.Fatalf("first Publish returned error: %v", err)
	}
	select {
	case <-inner.started:
	case <-time.After(time.Second):
		t.Fatal("inner publisher did not start")
	}
	if err := publisher.Publish(context.Background(), AccessEvent{RequestID: "REQ-2"}); err != nil {
		t.Fatalf("second Publish returned error: %v", err)
	}
	if err := publisher.Publish(context.Background(), AccessEvent{RequestID: "REQ-3"}); !errors.Is(err, errPublisherQueueFull) {
		t.Fatalf("third Publish error = %v, want %v", err, errPublisherQueueFull)
	}

	stats := publisher.Stats()
	if got := stats.Dropped.Load(); got != 1 {
		t.Fatalf("dropped events = %d, want 1", got)
	}
	close(inner.release)
	if err := publisher.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
}

func TestAsyncPublisherRejectsPublishAfterClose(t *testing.T) {
	inner := newFlakyPublisher(0)
	publisher := NewAsyncEventPublisher(
		inner,
		10,
		1,
		1,
		time.Millisecond,
		time.Millisecond,
		time.Millisecond,
	)
	if err := publisher.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}

	if err := publisher.Publish(context.Background(), AccessEvent{RequestID: "REQ-1"}); err == nil {
		t.Fatal("Publish after Close returned nil, want error")
	}
	stats := publisher.Stats()
	if got := stats.Dropped.Load(); got != 1 {
		t.Fatalf("dropped events = %d, want 1", got)
	}
}

func TestAsyncPublisherPublishBatchQueuesAllEvents(t *testing.T) {
	inner := newFlakyPublisher(0)
	publisher := NewAsyncEventPublisher(
		inner,
		10,
		1,
		10,
		time.Millisecond,
		time.Millisecond,
		time.Millisecond,
	)
	defer publisher.Close()

	events := []AccessEvent{
		{RequestID: "REQ-1", EmployeeID: "E1", Timestamp: time.Now().UTC()},
		{RequestID: "REQ-2", EmployeeID: "E2", Timestamp: time.Now().UTC()},
	}
	if err := publisher.PublishBatch(context.Background(), events); err != nil {
		t.Fatalf("PublishBatch returned error: %v", err)
	}

	select {
	case <-inner.publishedCh:
	case <-time.After(time.Second):
		t.Fatal("batch was not published")
	}

	if got := inner.publishedCount(); got != 2 {
		t.Fatalf("published count = %d, want 2", got)
	}
	stats := publisher.Stats()
	if got := stats.Queued.Load(); got != 2 {
		t.Fatalf("queued events = %d, want 2", got)
	}
}
