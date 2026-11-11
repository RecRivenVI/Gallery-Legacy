package media

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
)

type thumbnailWrite struct {
	job     *job
	preview imaging.Preview
	data    []byte
	done    chan error
}

func (c *Cache) persistThumbnail(j *job, preview imaging.Preview, data []byte) error {
	w := thumbnailWrite{j, preview, data, make(chan error, 1)}
	select {
	case c.writes <- w:
	case <-c.ctx.Done():
		return c.ctx.Err()
	}
	select {
	case err := <-w.done:
		return err
	case <-c.ctx.Done():
		return c.ctx.Err()
	}
}

func (c *Cache) writeThumbnails() {
	for {
		var first thumbnailWrite
		select {
		case <-c.ctx.Done():
			return
		case first = <-c.writes:
		}
		batch := []thumbnailWrite{first}
		timer := time.NewTimer(4 * time.Millisecond)
	collect:
		for len(batch) < 8 {
			select {
			case <-c.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
				break collect
			case w := <-c.writes:
				batch = append(batch, w)
			}
		}
		timer.Stop()
		for _, cover := range []bool{true, false} {
			var group []thumbnailWrite
			for _, w := range batch {
				if w.job.file.Cover == cover {
					group = append(group, w)
				}
			}
			if len(group) > 0 {
				c.saveThumbnailGroup(group)
			}
		}
	}
}

func (c *Cache) saveThumbnailGroup(group []thumbnailWrite) {
	err := c.index.saveGroup(c.ctx, group)
	for _, w := range group {
		result := err
		if result == nil {
			f := w.job.file
			relative, _ := filepath.Rel(f.Root, f.Path)
			// Commit the destination first. If interrupted here, the next
			// request can still use either copy and retire the duplicate.
			result = c.index.retire(c.ctx, w.job.key, f.Platform, strings.ToLower(filepath.ToSlash(relative)), f.Cover)
		}
		w.done <- result
	}
}

func (i *thumbnailIndex) saveGroup(ctx context.Context, group []thumbnailWrite) error {
	tx, err := i.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, w := range group {
		if err = storeThumbnail(ctx, tx, w.job, w.preview, w.data); err != nil {
			return err
		}
	}
	return tx.Commit()
}
