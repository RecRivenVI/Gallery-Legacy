package media

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func (c *Cache) preloadDisk(p *coverPreload, disk string, wake <-chan struct{}) {
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-wake:
		}
		for {
			if !c.beginBackground(c.ctx) {
				return
			}
			c.mu.Lock()
			taskCtx := p.ctx
			c.mu.Unlock()
			j, ok, err := c.takeCover(disk)
			if err != nil || !ok {
				c.finishBackground()
				if err != nil && !errors.Is(err, context.Canceled) {
					slog.Error("读取封面队列失败", "error", err)
				}
				break
			}
			f, err := preloadFile(p, j)
			// Header/path I/O ends here. A queued request owns no disk lease;
			// the render worker counts a background read only after dequeueing.
			c.finishBackground()
			if err == nil {
				_, _, err = c.Request(taskCtx, f, Display, Background)
			}
			state, failure := "done", ""
			if err != nil {
				state = "failed"
				failure = err.Error()
			}
			if _, writeErr := c.index.db.ExecContext(context.WithoutCancel(c.ctx), "UPDATE cover_jobs SET state=?,failure=? WHERE key=?", state, failure, j.key); writeErr != nil {
				slog.Error("保存封面进度失败", "error", writeErr)
			}
			if taskCtx.Err() != nil {
				break
			}
			if c.ctx.Err() != nil {
				return
			}
		}
	}
}
func preloadFile(p *coverPreload, j coverJob) (File, error) {
	path, err := library.Join(p.config.Sources[j.platform], j.relative)
	if err != nil {
		return File{}, err
	}
	if err = library.NoLinks(path); err != nil {
		return File{}, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return File{}, err
	}
	if info.Size() != j.size || info.ModTime().UnixNano() != j.mtime {
		return File{}, fmt.Errorf("MEDIA_CHANGED")
	}
	return File{Path: path, Root: p.config.Sources[j.platform], Info: info, Platform: j.platform, WorkID: strconv.FormatInt(j.work, 10), MediaID: strconv.FormatInt(j.media, 10), RelativeKey: strings.ToLower(strings.ReplaceAll(j.mediaRelative, "/", `\`)), Kind: j.kind, Cover: true}, nil
}
