package media

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"syscall"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"golang.org/x/sys/windows"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

type thumbnailDBError struct{ cause error }

func (e thumbnailDBError) Error() string { return e.cause.Error() }
func (e thumbnailDBError) Unwrap() error { return e.cause }

var errThumbnailEngine = errors.New("THUMBNAIL_ENGINE_UNAVAILABLE")

func coverFailure(err error) string {
	var dbErr thumbnailDBError
	var dbCode *sqlite.Error
	switch {
	case err == nil, errors.Is(err, context.Canceled):
		return ""
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, windows.ERROR_DISK_FULL), errors.Is(err, windows.ERROR_HANDLE_DISK_FULL), errors.As(err, &dbCode) && dbCode.Code() == sqlite3.SQLITE_FULL:
		return "THUMBNAIL_DISK_FULL"
	case errors.As(err, &dbErr):
		return "THUMBNAIL_CACHE_UNAVAILABLE"
	case errors.Is(err, errThumbnailEngine):
		return errThumbnailEngine.Error()
	}
	return ""
}

func (c *Cache) pauseCoverFailure(p *coverPreload, taskCtx context.Context, reason string, replan bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if p.ctx != taskCtx || taskCtx.Err() != nil || c.ctx.Err() != nil {
		return
	}
	c.backgroundPaused = true
	p.failure = reason
	p.restartPlan = p.restartPlan || replan
	c.ready.Broadcast()
	if _, err := c.index.db.ExecContext(c.ctx, "UPDATE cover_state SET paused=1,replan=? WHERE singleton=1", p.restartPlan); err != nil {
		slog.Warn("封面任务暂停状态未能保存", "code", reason, "error", err)
	}
}

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
					c.pauseCoverFailure(p, taskCtx, coverFailure(thumbnailDBError{err}), true)
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
			reason := coverFailure(err)
			if reason != "" || errors.Is(err, context.Canceled) {
				state = "pending"
			} else if err != nil {
				state = "failed"
				failure = err.Error()
			}
			if _, writeErr := c.index.db.ExecContext(context.WithoutCancel(c.ctx), "UPDATE cover_jobs SET state=?,failure=? WHERE key=? AND plan=?", state, failure, j.key, j.plan); writeErr != nil {
				slog.Error("保存封面进度失败", "error", writeErr)
				c.pauseCoverFailure(p, taskCtx, coverFailure(thumbnailDBError{writeErr}), true)
				break
			}
			if reason != "" {
				c.pauseCoverFailure(p, taskCtx, reason, false)
				break
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
