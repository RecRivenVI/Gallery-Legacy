package catalog

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/derived"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func ReleasePrepared(p PreparedWork) error {
	if p.StageFile == "" {
		return nil
	}
	err := derived.Remove(p.StageFile)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// Called under the scan lease, before any work stage can be active. Interrupted
// stages are re-prepared from source on the next scan, never partially resumed.
func RecoverWorkStages(root string) error {
	if err := library.NoLinks(root); err != nil {
		return err
	}
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && strings.HasPrefix(name, "pending-delivery-") && strings.HasSuffix(name, ".gob") {
			if err = derived.Remove(filepath.Join(root, name)); err != nil {
				return err
			}
			continue
		}
		if entry.IsDir() || !strings.HasPrefix(name, "large-work-") || !(strings.HasSuffix(name, ".sqlite") || strings.HasSuffix(name, ".sqlite-journal") || strings.HasSuffix(name, ".sqlite-wal") || strings.HasSuffix(name, ".sqlite-shm")) {
			continue
		}
		if err = derived.Remove(filepath.Join(root, entry.Name())); err != nil {
			return errors.Join(errors.New("WORK_STAGE_RECOVERY_FAILED"), err)
		}
	}
	return nil
}
