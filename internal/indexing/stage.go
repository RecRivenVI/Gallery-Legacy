package indexing

import (
	"context"
	"sync"
)

// Work messages share one bounded writer queue. An author completion follows
// its works; platform completion follows every author and the root check.
type platformStage struct {
	id     string
	ctx    context.Context
	output chan<- message
	budget *Budget
	mu     sync.Mutex
	jobs   sync.WaitGroup
	ends   chan *authorSession
	err    error
}

func (s *platformStage) fail(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err == nil {
		s.err = err
	}
}

func (s *platformStage) failure() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

func (s *platformStage) append(m message) error {
	m.platform = s.id
	if m.authority != nil {
		m.bytes += m.authority.Bytes
	}
	ctx := s.ctx
	if m.work != nil {
		ctx = context.WithoutCancel(ctx)
	}
	if err := s.budget.Acquire(ctx, m.bytes); err != nil {
		return err
	}
	select {
	case s.output <- m:
		return nil
	case <-ctx.Done():
		s.budget.Release(m.bytes)
		return ctx.Err()
	}
}
