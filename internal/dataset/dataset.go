// Package dataset assembles configuration, verified recovery and public reads.
// Opening a dataset never creates, upgrades or replaces a database.
package dataset

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
	"github.com/RecRivenVI/Gallery-Legacy/internal/recovery"
)

type Dataset struct {
	Config     instance.Config
	Generation *recovery.Checkpoint
	Reader     *reading.Reader
	Epoch      string
	Live       bool
}

// Load resolves only the configured pointer. An absent pointer means an empty
// static instance; invalid or incomplete recovery evidence is not ignored.
func Load(ctx context.Context, file string) (*Dataset, error) {
	config, err := instance.Load(file)
	if err != nil {
		return nil, err
	}
	generation, err := recovery.Active(ctx, config.InstanceRoot, config.GenerationsRoot, config.ActiveGenerationPath)
	if err != nil && !errors.Is(err, recovery.ErrActiveMissing) {
		return nil, err
	}
	return Open(ctx, config, generation)
}

// Open consumes an already verified READY checkpoint and an already prepared
// live database. Runtime ownership and schema upgrade belong to lifecycle.
func Open(ctx context.Context, config instance.Config, generation *recovery.Checkpoint) (*Dataset, error) {
	d := &Dataset{Config: config, Generation: generation, Epoch: "empty", Live: config.LiveUpdates}
	var err error
	if config.LiveUpdates {
		file := filepath.Join(config.InstanceRoot, "live/catalog.sqlite")
		if _, err = os.Stat(file); os.IsNotExist(err) {
			return nil, fmt.Errorf("LIVE_NOT_PREPARED")
		} else if err != nil {
			return nil, err
		}
		d.Reader, err = reading.OpenBound(ctx, file, "", true, config.Sources)
		if err != nil {
			if errors.Is(err, catalog.ErrSourceBindingMismatch) {
				return nil, fmt.Errorf("LIVE_SOURCE_BINDING_MISMATCH")
			}
			return nil, err
		}
		state, stateErr := d.Reader.Snapshot(ctx, func(v *reading.View) (any, error) { return v.LiveState() })
		if stateErr != nil {
			d.Close()
			return nil, stateErr
		}
		live := state.(catalog.LiveState)
		if generation != nil && (live.BaseGenerationID == nil || *live.BaseGenerationID != generation.GenerationID) {
			d.Close()
			return nil, fmt.Errorf("LIVE_BASE_GENERATION_MISMATCH")
		}
		d.Epoch = live.Epoch
		d.Reader.Epoch = live.Epoch
	} else if generation != nil {
		d.Epoch = generation.GenerationID
		d.Reader, err = reading.OpenStaticBound(ctx, generation.CatalogPath, generation.SearchPath, d.Epoch, config.Sources)
		if err != nil {
			return nil, err
		}
	}
	return d, nil
}

func (d *Dataset) Close() error {
	if d.Reader == nil {
		return nil
	}
	return d.Reader.Close()
}
