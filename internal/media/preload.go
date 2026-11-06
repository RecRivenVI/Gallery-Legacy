package media

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type coverPreload struct {
	ctx         context.Context
	cancel      context.CancelFunc
	planning    bool
	restartPlan bool
	request     PreloadRequest
	failure     string
	config      instance.Config
	wake        chan struct{}
	disks       map[string]string
	workers     map[string]chan struct{}
}

type coverJob struct {
	key, platform, relative, kind, disk string
	mediaRelative                       string
	work, media, size, mtime            int64
}

func (c *Cache) InitializePreload(config instance.Config) error {
	_, err := c.index.db.Exec(`CREATE TABLE IF NOT EXISTS cover_jobs(key TEXT PRIMARY KEY,platform TEXT NOT NULL,relative TEXT NOT NULL,work_id INTEGER NOT NULL,media_id INTEGER NOT NULL,kind TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,disk TEXT NOT NULL,position INTEGER NOT NULL DEFAULT -1,state TEXT NOT NULL,failure TEXT NOT NULL DEFAULT '',plan INTEGER NOT NULL,media_relative TEXT NOT NULL);CREATE TABLE IF NOT EXISTS cover_inventory(platform TEXT,key TEXT,relative TEXT,size INTEGER,mtime INTEGER,author TEXT,plan INTEGER,PRIMARY KEY(platform,key)) WITHOUT ROWID;CREATE INDEX IF NOT EXISTS cover_jobs_order ON cover_jobs(disk,state,position);CREATE TABLE IF NOT EXISTS cover_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),paused INTEGER NOT NULL);INSERT OR IGNORE INTO cover_state VALUES(1,1);UPDATE cover_state SET paused=1 WHERE singleton=1;CREATE TABLE IF NOT EXISTS cover_task(singleton INTEGER PRIMARY KEY CHECK(singleton=1),request TEXT NOT NULL);UPDATE cover_jobs SET state='pending' WHERE state='running';`)
	if err != nil {
		return fmt.Errorf("initialize cover preload: %w", err)
	}

	p := &coverPreload{ctx: c.ctx, config: config, wake: make(chan struct{}, 1), disks: map[string]string{}, workers: map[string]chan struct{}{}}
	if err = c.index.db.QueryRow("SELECT paused FROM cover_state WHERE singleton=1").Scan(&c.backgroundPaused); err != nil {
		return err
	}
	for id, root := range config.Sources {
		disk, limit := library.Disk(root)
		workers := 2
		if limit == 2 {
			workers = 1
		}
		p.disks[id] = disk
		if p.workers[disk] == nil {
			p.workers[disk] = make(chan struct{}, workers)
		}
	}
	var request string
	if err = c.index.db.QueryRow("SELECT request FROM cover_task WHERE singleton=1").Scan(&request); err == nil {
		if err = json.Unmarshal([]byte(request), &p.request); err != nil {
			return err
		}
	} else if err != sql.ErrNoRows {
		return err
	}
	c.preload = p
	for disk, wake := range p.workers {
		for range cap(wake) {
			c.workers.Go(func() { c.preloadDisk(p, disk, wake) })
		}
	}
	c.workers.Go(func() {
		for {
			select {
			case <-c.ctx.Done():
				return
			case <-p.wake:
			}
			c.mu.Lock()
			taskCtx, request := p.ctx, p.request
			c.mu.Unlock()
			if !c.beginBackground(taskCtx) {
				c.mu.Lock()
				if p.ctx == taskCtx {
					p.planning = false
				}
				c.mu.Unlock()
				if c.ctx.Err() != nil {
					return
				}
				continue
			}
			err := c.planInventoryCovers(taskCtx, p, request)
			c.mu.Lock()
			if p.ctx == taskCtx {
				p.planning = false
				p.failure = ""
				if err != nil && !errors.Is(err, context.Canceled) {
					p.failure = err.Error()
				}
			}
			c.mu.Unlock()
			c.finishBackground()
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					slog.Error("封面预生成准备失败", "error", err)
				}
				continue
			}
			for _, wake := range p.workers {
				for range cap(wake) {
					select {
					case wake <- struct{}{}:
					default:
					}
				}
			}
		}
	})
	return nil
}

func (c *Cache) beginBackground(ctx context.Context) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for ctx.Err() == nil && c.ctx.Err() == nil && (c.backgroundPaused || c.scanning) {
		c.ready.Wait()
	}
	if c.ctx.Err() != nil || ctx.Err() != nil {
		return false
	}
	c.backgroundActive++
	return true
}
func (c *Cache) finishBackground() {
	c.mu.Lock()
	c.backgroundActive--
	c.ready.Broadcast()
	c.mu.Unlock()
}

func (c *Cache) SetScanning(scanning bool) {
	c.mu.Lock()
	c.scanning = scanning
	if scanning {
		c.backgroundPaused = true
		if c.preload != nil && c.preload.planning && c.preload.cancel != nil {
			c.preload.restartPlan = true
			c.preload.cancel()
		}
	}
	c.ready.Broadcast()
	for scanning && c.backgroundActive > 0 {
		c.ready.Wait()
	}
	c.mu.Unlock()
	if scanning && c.preload != nil {
		if _, err := c.index.db.ExecContext(c.ctx, "UPDATE cover_state SET paused=1 WHERE singleton=1"); err != nil {
			slog.Warn("封面暂停状态未能保存", "error", err)
		}
	}

}
func (c *Cache) PausePreload(paused bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.preload == nil {
		return nil
	}
	if !paused && c.scanning {
		return fmt.Errorf("SCAN_IN_USE")
	}
	if _, err := c.index.db.ExecContext(c.ctx, "UPDATE cover_state SET paused=? WHERE singleton=1", paused); err != nil {
		return err
	}
	c.backgroundPaused = paused
	if paused && c.preload.planning && c.preload.cancel != nil {
		c.preload.restartPlan = true
		c.preload.cancel()
	}
	if !paused && c.preload.restartPlan {
		c.preload.ctx, c.preload.cancel = context.WithCancel(c.ctx)
		c.preload.restartPlan = false
		c.preload.planning = true
		select {
		case c.preload.wake <- struct{}{}:
		default:
		}
	}
	c.ready.Broadcast()
	if !paused && !c.preload.planning {
		for _, wake := range c.preload.workers {
			for range cap(wake) {
				select {
				case wake <- struct{}{}:
				default:
				}
			}
		}
	}
	return nil
}
func (c *Cache) PreloadStatus(ctx context.Context) (map[string]any, error) {
	if c.preload == nil {
		return map[string]any{"total": 0, "completed": 0, "failed": 0, "paused": false, "running": false}, nil
	}
	var total, completed, failed int64
	err := c.index.db.QueryRowContext(ctx, "SELECT count(*),coalesce(sum(state='done'),0),coalesce(sum(state='failed'),0) FROM cover_jobs").Scan(&total, &completed, &failed)
	if err != nil {
		return nil, fmt.Errorf("read cover preload progress: %w", err)
	}
	c.mu.Lock()
	paused := c.backgroundPaused
	scanning := c.scanning
	active := c.backgroundActive
	request := c.preload.request
	planning := c.preload.planning
	failure := c.preload.failure
	c.mu.Unlock()
	return map[string]any{"total": total, "completed": completed, "failed": failed, "paused": paused, "waitingForScan": scanning, "mode": request.Mode, "platformIds": request.Platforms, "planning": planning, "failure": failure, "running": planning || active > 0 || !paused && !scanning && completed+failed < total}, nil
}
