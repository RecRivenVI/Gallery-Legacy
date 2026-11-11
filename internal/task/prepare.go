package task

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/recovery"
)

func Layout(c instance.Config) error {
	for _, p := range []string{c.InstanceRoot, c.GenerationsRoot, c.CacheRoot, c.LogsRoot, c.TempRoot, c.StateRoot, c.ReportsRoot, c.DesktopDataRoot} {
		if err := os.MkdirAll(p, 0700); err != nil {
			return err
		}
	}
	return nil
}
func Prepare(ctx context.Context, c instance.Config) (resultErr error) {
	lease, err := control.Acquire(c, "maintenance", nil)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, lease.Close()) }()
	g, err := recovery.Active(ctx, c.InstanceRoot, c.GenerationsRoot, c.ActiveGenerationPath)
	if err != nil && !errors.Is(err, recovery.ErrActiveMissing) {
		return err
	}
	if errors.Is(err, recovery.ErrActiveMissing) {
		entries, e := os.ReadDir(c.GenerationsRoot)
		if e != nil {
			return e
		}
		for _, entry := range entries {
			var m Row
			if control.ReadJSON(filepath.Join(c.GenerationsRoot, entry.Name(), "manifest.json"), &m) == nil && m["state"] == "READY" {
				return fmt.Errorf("GENERATION_ACTIVE_POINTER_MISSING")
			}
		}
	}
	if !c.LiveUpdates {
		return nil
	}
	file := filepath.Join(c.InstanceRoot, "live/catalog.sqlite")
	if _, err = os.Stat(file); os.IsNotExist(err) {
		var base *catalog.LiveBase
		if g != nil {
			base = &catalog.LiveBase{CatalogPath: g.CatalogPath, GenerationID: g.GenerationID}
		}
		return catalog.CreateLiveFrom(ctx, c.InstanceRoot, c.Sources, base)
	} else if err != nil {
		return err
	}
	w, err := catalog.Open(file)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, w.Close()) }()
	_, err = catalog.UpgradeLive(ctx, w.DB, c.Sources)
	return err
}
