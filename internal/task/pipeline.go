package task

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/indexing"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/recovery"
)

func runPipeline(ctx context.Context, c instance.Config, in ScanInput, ids []string, id string, delay time.Duration, persist func(indexing.Status)) (workingRoot string, err error) {
	author := ""
	if in.Author != nil {
		author = *in.Author
	}
	workingRoot = c.InstanceRoot
	if err = Prepare(ctx, c); err == nil {
		if !c.LiveUpdates {
			workingRoot = filepath.Join(c.TempRoot, id)
			err = os.Mkdir(workingRoot, 0700)
			if err == nil {
				var base *catalog.LiveBase
				g, e := recovery.Active(ctx, c.InstanceRoot, c.GenerationsRoot, c.ActiveGenerationPath)
				if e != nil && !errors.Is(e, recovery.ErrActiveMissing) {
					err = e
				} else {
					if g != nil {
						base = &catalog.LiveBase{CatalogPath: g.CatalogPath, GenerationID: g.GenerationID}
					}
					err = catalog.CreateLiveFrom(ctx, workingRoot, c.Sources, base)
				}
			}
		}
		scanFile := filepath.Join(c.StateRoot, "scanner.json")
		if err == nil {
			scanFile = filepath.Join(workingRoot, "state/scanner.json")
			err = instance.WriteJSON(scanFile, library.Config{InstanceRoot: workingRoot, Database: filepath.Join(workingRoot, "live/catalog.sqlite"), Sources: c.Sources, TestOnly: true, ListingSource: "filesystem"})
		}
		if err == nil {
			var config library.Config
			config, err = library.Load(scanFile)
			if err == nil {
				p := indexing.Pipeline{Config: config, Mode: in.Mode, AuthorDirectoryName: author, Delay: delay, Emit: persist}
				err = p.Run(ctx, ids)
			}
		}
	}
	return workingRoot, err
}
