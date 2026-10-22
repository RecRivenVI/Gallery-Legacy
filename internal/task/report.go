package task

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

// A completed database commit is retained even if its private report cannot be
// saved, but the task must not advertise that reporting succeeded.
func reportFailure(c instance.Config, state Row, cause error) error {
	state["state"], state["running"] = "FAILED", false
	state["failure"] = Row{"code": "SCAN_REPORT_WRITE_FAILED"}
	return errors.Join(fmt.Errorf("SCAN_REPORT_WRITE_FAILED: %w", cause), instance.WriteJSON(c.ScanStatusPath, state))
}

func reportCounts(ctx context.Context, c instance.Config, root string) (counts Row, err error) {
	r, err := reading.OpenBound(ctx, filepath.Join(root, "live/catalog.sqlite"), "live", true, c.Sources)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, r.Close()) }()
	value, err := r.Snapshot(ctx, func(v *reading.View) (any, error) { return v.Stats() })
	if err != nil {
		return nil, err
	}
	return value.(reading.Row), nil
}
