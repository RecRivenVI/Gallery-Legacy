package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

var cacheShard = regexp.MustCompile(`^[a-f0-9]{2}$`)
var cacheImage = regexp.MustCompile(`^[a-f0-9]{64}\.webp$`)

func orphanCache(c instance.Config, apply bool) (any, error) {
	root := filepath.Join(c.CacheRoot, "thumbnails")
	result := Row{"files": 0, "orphanFiles": 0, "orphanBytes": int64(0), "retained": 0, "unknown": 0, "removed": 0, "removedBytes": int64(0)}
	if err := library.NoLinks(root); err != nil {
		return nil, err
	}
	dirs, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	for _, dir := range dirs {
		if !dir.IsDir() || !cacheShard.MatchString(dir.Name()) {
			continue
		}
		folder := filepath.Join(root, dir.Name())
		if err = library.NoLinks(folder); err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(folder)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if !entry.Type().IsRegular() || !cacheImage.MatchString(entry.Name()) {
				continue
			}
			image := filepath.Join(folder, entry.Name())
			reference := image + ".json"
			for _, p := range []string{image, reference} {
				if err = library.NoLinks(p); err != nil {
					return nil, err
				}
			}
			result["files"] = result["files"].(int) + 1
			var record struct {
				Version int    `json:"version"`
				Source  string `json:"source"`
			}
			known := control.ReadJSON(reference, &record) == nil && record.Version == 1 && record.Source != ""
			protected := false
			for _, r := range c.ProtectedRoots {
				root, _ := r["physicalRoot"].(string)
				if library.Inside(root, record.Source) {
					protected = true
				}
			}
			if !known || !protected {
				result["unknown"] = result["unknown"].(int) + 1
				continue
			}
			missing := func() bool {
				if library.NoLinks(record.Source) != nil {
					return false
				}
				_, e := os.Lstat(record.Source)
				return os.IsNotExist(e)
			}
			if !missing() {
				result["retained"] = result["retained"].(int) + 1
				continue
			}
			st, err := os.Lstat(image)
			if err != nil {
				return nil, err
			}
			result["orphanFiles"] = result["orphanFiles"].(int) + 1
			result["orphanBytes"] = result["orphanBytes"].(int64) + st.Size()
			if apply && missing() {
				if err = instance.Recycle(image); err != nil {
					return nil, err
				}
				if err = instance.Recycle(reference); err != nil {
					return nil, err
				}
				result["removed"] = result["removed"].(int) + 1
				result["removedBytes"] = result["removedBytes"].(int64) + st.Size()
			}
		}
	}
	return result, nil
}
func cacheOperation(c instance.Config, op string, input Row) (value any, err error) {
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
	return orphanCache(c, op == "cache.orphans.clear")
}
