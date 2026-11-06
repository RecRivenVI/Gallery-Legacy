package indexing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/physical"
)

type physicalOrder func(context.Context, library.Config, []string) (string, func(), error)

func (p *Pipeline) loadPhysical(ctx context.Context, l *library.Listing, platform string) error {
	if p.PhysicalOrder == nil {
		return nil
	}
	at := time.Now()
	file, cleanup, err := p.PhysicalOrder(ctx, p.Config, []string{platform})
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		p.addIssue(platform, "", "warning", "PHYSICAL_ORDER_UNAVAILABLE")
		slog.WarnContext(ctx, "元数据位置不可用，按目录顺序读取", "platform", platform, "code", code(err), "error", err)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return nil
	}
	if file == "" {
		return nil
	}
	if err = p.readPositions(ctx, l, platform, file); err != nil {
		if clear := l.ClearPositions(ctx, platform); clear != nil {
			return fmt.Errorf("clear incomplete allocation hints: %w", clear)
		}
		p.addIssue(platform, "", "warning", "PHYSICAL_ORDER_UNAVAILABLE")
		slog.WarnContext(ctx, "元数据位置不完整，按目录顺序读取", "platform", platform, "error", err)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return nil
	}
	slog.InfoContext(ctx, "元数据位置读取完成", "platform", platform, "elapsedMs", time.Since(at).Milliseconds())
	return nil
}

func (p *Pipeline) readPositions(ctx context.Context, l *library.Listing, platform, file string) error {
	if err := library.NoLinks(file); err != nil {
		return err
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	d := json.NewDecoder(f)
	batch := make([]library.PositionedEntry, 0, 1024)
	flush := func() error { err := l.PutPositions(ctx, batch); batch = batch[:0]; return err }
	var count int64
	for {
		var r physical.OrderRecord
		if err = d.Decode(&r); err != nil {
			return fmt.Errorf("NTFS_ORDER_INCOMPLETE: %w", err)
		}
		if r.Complete {
			if r.Files != count {
				return errors.New("NTFS_ORDER_INCOMPLETE")
			}
			if err = flush(); err != nil {
				return err
			}
			if err = d.Decode(&r); err != io.EOF {
				return errors.New("NTFS_ORDER_TRAILING_DATA")
			}
			slog.InfoContext(ctx, "元数据读取顺序已安排", "platform", platform, "files", count, "unknownPositions", r.Unknown)
			return nil
		}
		if r.Platform != platform || !strings.HasSuffix(strings.ToLower(r.Relative), `\metadata.json`) || strings.Count(r.Relative, `\`) != 2 {
			return errors.New("NTFS_ORDER_SCOPE_INVALID")
		}
		if _, err = library.Join(p.Config.Sources[platform], r.Relative); err != nil {
			return err
		}
		batch = append(batch, library.PositionedEntry{Entry: library.Entry{Platform: platform, Relative: r.Relative, Key: strings.ToLower(r.Relative), Size: r.Size, Mtime: r.Mtime}, Offset: r.Offset})
		count++
		if len(batch) == cap(batch) {
			if err = flush(); err != nil {
				return err
			}
		}
	}
}
