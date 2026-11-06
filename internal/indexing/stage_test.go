package indexing

import (
	"context"
	"errors"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"testing"
)

func TestWorkQueueDoesNotWaitForPlatformOrAuthorCompletion(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	queue := make(chan message, 1)
	budget := NewBudget(10)
	s := &platformStage{id: "pixiv", ctx: ctx, output: queue, budget: budget}
	w := catalog.PreparedWork{Work: catalog.Row{"mtime": int64(1791567530000000123)}}
	if err := s.append(message{work: &w, bytes: 8}); err != nil {
		t.Fatal(err)
	}
	m := <-queue
	if m.work != &w || m.platform != "pixiv" || budget.used != 8 {
		t.Fatal("work not immediately queued or budget released early")
	}
	blocked := make(chan error, 1)
	go func() { blocked <- s.append(message{bytes: 3}) }()
	cancel()
	if err := <-blocked; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	budget.Release(m.bytes)
	if budget.used != 0 {
		t.Fatal("queue reservation leaked")
	}
	s.fail(errors.New("FILESYSTEM_INCOMPLETE"))
	if s.failure() == nil {
		t.Fatal("scope failure lost")
	}
}
