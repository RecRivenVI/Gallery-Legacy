package host

import (
	"context"
	"errors"
	"fmt"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
)

func orphanCache(ctx context.Context, c instance.Config, apply bool) (any, error) {
	return media.OrphanCache(ctx, c, apply)
}
func cacheOperation(ctx context.Context, c instance.Config, op string, input Row) (value any, err error) {
	if op == "cache.orphans.clear" && input["confirm"] != true {
		return nil, fmt.Errorf("CONFIRMATION_REQUIRED")
	}
	lease, err := control.Acquire(c, "maintenance", nil)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, lease.Close()) }()
	if op == "cache.orphans.clear" {
		if err = idle(c); err != nil {
			return nil, err
		}
	}
	return orphanCache(ctx, c, op == "cache.orphans.clear")
}
