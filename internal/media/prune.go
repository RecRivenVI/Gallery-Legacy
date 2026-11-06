package media

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func (i *thumbnailIndex) prune(ctx context.Context, config instance.Config, apply bool) (result map[string]any, err error) {
	result = map[string]any{"files": int64(0), "orphanFiles": int64(0), "orphanBytes": int64(0), "retained": int64(0), "unknown": int64(0), "removed": int64(0), "removedBytes": int64(0)}
	var count int64
	if err = i.db.QueryRowContext(ctx, "SELECT count(*) FROM thumbnails").Scan(&count); err != nil {
		return nil, err
	}
	result["files"] = count
	if !config.LiveUpdates {
		result["unknown"] = count
		return result, nil
	}
	file := filepath.Join(config.InstanceRoot, "live/catalog.sqlite")
	if err = library.NoLinks(file); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(file)}
	u.RawQuery = "mode=ro"
	if _, err = i.db.ExecContext(ctx, "ATTACH DATABASE ? AS source_catalog", u.String()); err != nil {
		return nil, fmt.Errorf("open cache source facts: %w", err)
	}
	defer func() {
		_, e := i.db.ExecContext(context.WithoutCancel(ctx), "DETACH DATABASE source_catalog")
		err = errors.Join(err, e)
	}()
	def, err := api.LoadCatalog()
	if err != nil {
		return nil, err
	}
	marks, args := []string{}, []any{}
	for _, p := range def.Platforms {
		marks = append(marks, "?")
		args = append(args, p.ID)
	}
	query := `SELECT t.key,t.bytes FROM thumbnails t LEFT JOIN source_catalog.works w ON w.platform_id=t.platform AND w.relative_path_key=t.work_relative LEFT JOIN source_catalog.media m ON m.work_id=w.work_id AND m.relative_path_key=t.media_relative WHERE t.platform IN (` + strings.Join(marks, ",") + `) AND (m.media_id IS NULL OR m.filesystem_size!=t.size OR m.filesystem_mtime_ns!=t.mtime) AND t.key>? ORDER BY t.key LIMIT 256`
	after := ""
	for {
		rows, e := i.db.QueryContext(ctx, query, append(append([]any{}, args...), after)...)
		if e != nil {
			return nil, e
		}
		type entry struct {
			key  string
			size int64
		}
		entries := []entry{}
		for rows.Next() {
			var item entry
			if e = rows.Scan(&item.key, &item.size); e != nil {
				break
			}
			entries = append(entries, item)
		}
		e = errors.Join(e, rows.Err(), rows.Close())
		if e != nil {
			return nil, e
		}
		if len(entries) == 0 {
			break
		}
		for _, item := range entries {
			after = item.key
			result["orphanFiles"] = result["orphanFiles"].(int64) + 1
			result["orphanBytes"] = result["orphanBytes"].(int64) + item.size
			if !apply {
				continue
			}
			if item.size > 0 {
				target := filepath.Join(config.CacheRoot, "thumbnails", item.key[:2], item.key[2:4], item.key+".webp")
				if e = instance.RemoveOwned(target); e != nil && !os.IsNotExist(e) {
					return nil, e
				}
			}
			if _, e = i.db.ExecContext(ctx, "DELETE FROM thumbnails WHERE key=?", item.key); e != nil {
				return nil, e
			}
			result["removed"] = result["removed"].(int64) + 1
			result["removedBytes"] = result["removedBytes"].(int64) + item.size
		}
	}
	result["retained"] = count - result["orphanFiles"].(int64)
	return result, nil
}

// OrphanCache inspects committed source facts only. It never probes the source
// filesystem to decide whether a derived file can be recycled.
func OrphanCache(ctx context.Context, config instance.Config, apply bool) (map[string]any, error) {
	file := filepath.Join(config.CacheRoot, "thumbs.db")
	if _, err := os.Stat(file); os.IsNotExist(err) {
		return map[string]any{"files": 0, "orphanFiles": 0, "orphanBytes": 0, "retained": 0, "unknown": 0, "removed": 0, "removedBytes": 0}, nil
	} else if err != nil {
		return nil, err
	}
	i, err := openThumbnailIndex(file)
	if err != nil {
		return nil, err
	}
	defer i.db.Close()
	return i.prune(ctx, config, apply)
}
