package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/physical"
)

func (c *Cache) orderCovers(ctx context.Context, p *coverPreload) error {
	var platforms []string
	for id, root := range p.config.Sources {
		_, limit := library.Disk(root)
		if limit == 2 {
			platforms = append(platforms, id)
		}
	}
	if len(platforms) == 0 {
		return nil
	}
	var pending int
	if err := c.index.db.QueryRowContext(ctx, "SELECT count(*) FROM cover_jobs WHERE state='pending'").Scan(&pending); err != nil {
		return err
	}
	if pending == 0 {
		return nil
	}
	config := library.Config{InstanceRoot: p.config.InstanceRoot, Database: filepath.Join(p.config.InstanceRoot, "live/catalog.sqlite"), Sources: p.config.Sources, TestOnly: true, ListingSource: "auto"}

	file, cleanup, err := physical.CoverOrder(ctx, config, platforms, filepath.Join(p.config.CacheRoot, "thumbs.db"))
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		slog.Warn("封面位置不可用，按作品顺序生成", "error", err)
		return ctx.Err()
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	d := json.NewDecoder(f)
	tx, err := c.index.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var count int64
	for {
		var record physical.OrderRecord
		if err = d.Decode(&record); err != nil {
			return err
		}
		if record.Complete {
			if record.Files != count {
				return fmt.Errorf("NTFS_ORDER_INCOMPLETE")
			}
			if err = d.Decode(&record); !errors.Is(err, io.EOF) {
				return fmt.Errorf("NTFS_ORDER_TRAILING_DATA")
			}
			break
		}
		if _, ok := p.config.Sources[record.Platform]; !ok {
			return fmt.Errorf("NTFS_ORDER_SCOPE_INVALID")
		}
		if _, err = library.Join(p.config.Sources[record.Platform], record.Relative); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE cover_jobs SET position=? WHERE platform=? AND relative=? AND size=? AND mtime=?", record.Offset, record.Platform, strings.ReplaceAll(record.Relative, "/", `\`), record.Size, record.Mtime); err != nil {
			return err
		}
		count++
	}
	return tx.Commit()
}
