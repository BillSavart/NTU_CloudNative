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
