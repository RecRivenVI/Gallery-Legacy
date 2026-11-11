package task

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type MetadataStatus struct {
	catalog.MetadataProgress
	State   string `json:"state"`
	Failure string `json:"failure,omitempty"`
}

type MetadataRefresh struct {
	config                 instance.Config
	mu                     sync.Mutex
	status                 MetadataStatus
	preference             string
	wake                   chan struct{}
	cancel                 context.CancelFunc
	done                   chan struct{}
	scan, requested, retry bool
}

func NewMetadataRefresh(c instance.Config) *MetadataRefresh {
	m := &MetadataRefresh{config: c, wake: make(chan struct{}, 1), requested: c.LiveUpdates, status: MetadataStatus{State: "IDLE"}}
	var saved struct {
		Preference string
		Progress   catalog.MetadataProgress
	}
	if err := control.ReadJSON(m.preferencePath(), &saved); err == nil {
		switch saved.Preference {
		case "PAUSED", "CANCELLED":
			m.preference = saved.Preference
			m.status.State = saved.Preference
			m.status.MetadataProgress = saved.Progress
		}
	}
	return m
}

func (m *MetadataRefresh) preferencePath() string {
	return filepath.Join(m.config.StateRoot, "metadata-refresh.json")
}

func (m *MetadataRefresh) Status() MetadataStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *MetadataRefresh) signal() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *MetadataRefresh) Control(operation string) (MetadataStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.config.LiveUpdates {
		return m.status, fmt.Errorf("METADATA_REFRESH_UNAVAILABLE")
	}
	if operation == "pause" || operation == "cancel" {
		preference := "PAUSED"
		if operation == "cancel" {
			preference = "CANCELLED"
		}
		if err := instance.WriteJSON(m.preferencePath(), Row{"preference": preference, "progress": m.status.MetadataProgress}); err != nil {
			return m.status, err
		}
		m.preference, m.status.State, m.status.Failure = preference, preference, ""
		if m.cancel != nil {
			m.cancel()
		}
		return m.status, nil
	}
	if operation != "resume" {
		return m.status, fmt.Errorf("INVALID_INPUT")
	}
	if err := instance.WriteJSON(m.preferencePath(), Row{"preference": ""}); err != nil {
		return m.status, err
	}
	m.preference = ""
	m.retry = m.retry || m.status.Failed > 0
	m.requested = true
	m.status.Failure = ""
	if m.scan {
		m.status.State = "WAITING_FOR_SCAN"
	} else {
		m.status.State = "PREPARING"
	}
	m.signal()
	return m.status, nil
}

func (m *MetadataRefresh) HoldForScan(ctx context.Context) error {
	m.mu.Lock()
	m.scan = true
	done := m.done
	if m.cancel != nil {
		m.status.State = "WAITING_FOR_SCAN"
		m.cancel()
	}
	m.mu.Unlock()
	if done != nil {
		select {
		case <-ctx.Done():
			m.ReleaseScan()
			return ctx.Err()
		case <-done:
		}
	}
	return nil
}

func (m *MetadataRefresh) ReleaseScan() {
	m.mu.Lock()
	m.scan = false
	m.signal()
	m.mu.Unlock()
}

func (m *MetadataRefresh) Run(ctx context.Context, reserve func(context.Context) func()) {
	if !m.config.LiveUpdates {
		return
	}
	m.signal()
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.wake:
		}
		m.mu.Lock()
		if ctx.Err() != nil || m.preference != "" || m.scan || !m.requested {
			m.mu.Unlock()
			continue
		}
		run, cancel := context.WithCancel(ctx)
		done := make(chan struct{})
		m.cancel, m.done = cancel, done
		retry := m.retry
		m.retry, m.requested = false, false
		m.status.State = "PREPARING"
		m.mu.Unlock()

		start := time.Now()
		release := reserve(run)
		err := m.refresh(run, retry)
		release()
		interrupted := run.Err() != nil
		cancel()

		m.mu.Lock()
		m.cancel, m.done = nil, nil
		close(done)
		switch {
		case m.preference != "":
			m.status.State = m.preference
		case interrupted:
			m.requested = true
			if m.scan {
				m.status.State = "WAITING_FOR_SCAN"
			} else {
				m.signal()
			}
		case err != nil:
			m.status.State, m.status.Failure = "FAILED", "METADATA_REFRESH_FAILED"
		case m.status.Failed > 0:
			m.status.State, m.status.Failure = "FAILED", "METADATA_REFRESH_SOURCE_FAILED"
		default:
			m.status.State = "COMPLETE"
		}
		progress := m.status.MetadataProgress
		m.mu.Unlock()
		if err != nil && !interrupted {
			slog.ErrorContext(ctx, "作品信息升级未完成", "code", control.Code(err, "METADATA_REFRESH_FAILED"))
		}
		if progress.Total > 0 {
			slog.InfoContext(ctx, "作品信息升级", "elapsedMs", time.Since(start).Milliseconds(), "total", progress.Total, "works", progress.Completed, "skipped", progress.Skipped, "failed", progress.Failed, "targetWorks", progress.TitleTotal, "targetRead", progress.TitleRead, "complete", err == nil && progress.Failed == 0)
		}
	}
}

func (m *MetadataRefresh) refresh(ctx context.Context, retry bool) (result error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	release, err := library.Lease(filepath.Join(m.config.StateRoot, "go-scan.lock"))
	if err != nil {
		return fmt.Errorf("acquire metadata refresh writer: %w", err)
	}
	defer release()
	w, err := catalog.Open(filepath.Join(m.config.InstanceRoot, "live", "catalog.sqlite"))
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, w.Close()) }()
	if err = w.AssertBindings(ctx, m.config.Sources); err != nil {
		return err
	}
	if err = w.PlanMetadataRefresh(ctx, m.config.Sources, m.config.StateRoot, retry); err != nil {
		return err
	}
	return w.ReparseMetadata(ctx, m.config.Sources, func(p catalog.MetadataProgress) {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.status.MetadataProgress = p
		if m.preference == "" && !m.scan {
			m.status.State = "RUNNING"
		}
	})
}
