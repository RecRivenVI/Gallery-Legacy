package media

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func (i *thumbnailIndex) prune(ctx context.Context, config instance.Config, apply bool) (result map[string]any, err error) {
	result = map[string]any{"files": int64(0), "orphanFiles": int64(0), "orphanBytes": int64(0), "retained": int64(0), "unknown": int64(0), "removed": int64(0), "removedBytes": int64(0)}
	var count int64
	if err = i.db.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM main.thumbnails)+(SELECT count(*) FROM preview.thumbnails)").Scan(&count); err != nil {
		return nil, err
	}
	result["files"] = count
	if !config.LiveUpdates {
		result["unknown"] = count
		return result, nil
	}
	file := filepath.Join(config.InstanceRoot, "live", "catalog.sqlite")
	if err = library.NoLinks(file); err != nil {
		return nil, err
	}
	conn, err := i.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "ATTACH DATABASE ? AS source_catalog", thumbnailURI(file, "mode=ro")); err != nil {
		return nil, fmt.Errorf("open cache source facts: %w", err)
	}
	defer func() {
		_, e := conn.ExecContext(context.WithoutCancel(ctx), "DETACH DATABASE source_catalog")
		err = errors.Join(err, e)
	}()
	const absent = "t.media<>'' AND NOT EXISTS(SELECT 1 FROM source_catalog.media m JOIN source_catalog.works w USING(work_id) WHERE m.media_id=CAST(t.media AS INTEGER) AND w.platform_id=t.platform AND m.filesystem_size=t.source_size AND m.filesystem_mtime_ns=t.mtime)"
	const noLongerCover = "t.media<>'' AND EXISTS(SELECT 1 FROM source_catalog.media m JOIN source_catalog.works w USING(work_id) WHERE m.media_id=CAST(t.media AS INTEGER) AND w.platform_id=t.platform AND m.filesystem_size=t.source_size AND m.filesystem_mtime_ns=t.mtime AND w.cover_media_id IS NOT m.media_id)"
	if apply {
		// A former cover remains usable in the rolling cache. Commit the
		// new copy before retiring the permanent one.
		if _, err = conn.ExecContext(ctx, "INSERT OR IGNORE INTO preview.thumbnails SELECT t.* FROM main.thumbnails t WHERE "+noLongerCover); err != nil {
			return nil, err
		}
		if _, err = conn.ExecContext(ctx, "DELETE FROM main.thumbnails AS t WHERE "+noLongerCover); err != nil {
			return nil, err
		}
	}
	for _, table := range []string{"main.thumbnails", "preview.thumbnails"} {
		var orphanCount, orphanBytes int64
		if err = conn.QueryRowContext(ctx, "SELECT count(*),coalesce(sum(length(image)),0) FROM "+table+" t WHERE "+absent).Scan(&orphanCount, &orphanBytes); err != nil {
			return nil, err
		}
		result["orphanFiles"] = result["orphanFiles"].(int64) + orphanCount
		result["orphanBytes"] = result["orphanBytes"].(int64) + orphanBytes
		if apply && orphanCount > 0 {
			if _, err = conn.ExecContext(ctx, "DELETE FROM "+table+" AS t WHERE "+absent); err != nil {
				return nil, err
			}
			result["removed"] = result["removed"].(int64) + orphanCount
			result["removedBytes"] = result["removedBytes"].(int64) + orphanBytes
		}
	}
	result["retained"] = count - result["orphanFiles"].(int64)
	return result, nil
}

func OrphanCache(ctx context.Context, config instance.Config, apply bool) (map[string]any, error) {
	_, a := os.Stat(filepath.Join(config.CacheRoot, "covers.sqlite"))
	_, b := os.Stat(filepath.Join(config.CacheRoot, "previews.sqlite"))
	if os.IsNotExist(a) && os.IsNotExist(b) {
		return map[string]any{"files": 0, "orphanFiles": 0, "orphanBytes": 0, "retained": 0, "unknown": 0, "removed": 0, "removedBytes": 0}, nil
	}
	if a != nil && !os.IsNotExist(a) || b != nil && !os.IsNotExist(b) {
		return nil, errors.Join(a, b)
	}
	i, err := openThumbnailIndex(config.CacheRoot)
	if err != nil {
		return nil, err
	}
	defer i.db.Close()
	return i.prune(ctx, config, apply)
}
