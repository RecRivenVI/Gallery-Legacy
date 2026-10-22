package host

import (
	"fmt"
	"log/slog"

	"github.com/RecRivenVI/Gallery-Legacy/internal/inspection"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func (s *Session) startValidation(c instance.Config, input Row) (any, error) {
	selection, err := inspection.Select(c, input)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.validationDone != nil {
		select {
		case <-s.validationDone:
		default:
			return nil, fmt.Errorf("VALIDATION_IN_USE")
		}
	}
	done := make(chan struct{})
	started := make(chan Row, 1)
	failed := make(chan error, 1)
	s.validationDone = done
	s.tasks.Add(1)
	go func() {
		defer s.tasks.Done()
		defer close(done)
		err := inspection.Run(s.ctx, c, selection, func(row Row) { started <- row })
		if err != nil {
			slog.Error("检查没有完成", "event", "validation.failed", "error", err)
		}
		failed <- err
	}()
	select {
	case row := <-started:
		return row, nil
	case err := <-failed:
		select {
		case row := <-started:
			return row, nil
		default:
			return nil, err
		}
	}
}
