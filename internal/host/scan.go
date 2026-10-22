package host

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/task"
)

func (r *Runtime) startScan(input Row) (any, error) {
	c, err := instance.Load(r.options.ConfigFile)
	if err != nil {
		return nil, err
	}
	in, ids, err := task.Parse(input)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state["state"] != "READY" || r.ctx.Err() != nil {
		return nil, fmt.Errorf("RUNTIME_OFFLINE")
	}
	if r.scanDone != nil {
		select {
		case <-r.scanDone:
		default:
			state, e := task.State(c)
			if e != nil {
				return nil, e
			}
			if state["running"] == true {
				return nil, fmt.Errorf("SCAN_IN_USE")
			}
			// A persisted terminal result can precede the goroutine's deferred
			// lease release. Serialize that hand-off, not a new scan rejection.
			<-r.scanDone
		}
	}
	ctx, cancel := context.WithCancel(r.ctx)
	done := make(chan struct{})
	started := make(chan Row, 1)
	failed := make(chan error, 1)
	r.scanDone = done
	r.tasks.Add(1)
	go func() {
		defer r.tasks.Done()
		defer close(done)
		defer cancel()
		err := task.Run(ctx, c, in, ids, 0, func(value Row) { started <- value })
		if err != nil {
			slog.Error("更新没有完成", "event", "scan.task_error", "code", control.Code(err, "SCAN_NOT_COMPLETE"))
		}
		if err == nil && !c.LiveUpdates {
			if _, cleanup := manageRecovery(context.WithoutCancel(ctx), c, "retention.apply", Row{"confirm": true}); cleanup != nil {
				code := control.Code(cleanup, "RETENTION_FAILED")
				if e := instance.WriteJSON(filepath.Join(c.ReportsRoot, "retention-error.json"), Row{"code": code}); e != nil {
					slog.Error("清理结果没有保存", "message", "清理结果没有保存")
				}
				slog.Warn("旧版本清理未完成", "message", "旧版本清理未完成", "code", code)
			}
		}
		failed <- err
	}()
	select {
	case value := <-started:
		return value, nil
	case err := <-failed:
		select {
		case value := <-started:
			return value, nil
		default:
			return nil, err
		}
	}
}
