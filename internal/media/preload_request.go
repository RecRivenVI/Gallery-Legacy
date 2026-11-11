package media

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type PreloadRequest struct {
	Mode      string              `json:"mode"`
	Platforms []string            `json:"platformIds"`
	Authors   map[string][]string `json:"authors"`
}

func (c *Cache) StartPreloadTask(ctx context.Context, request PreloadRequest) error {
	return c.startPreloadTask(ctx, request, false)
}

func (c *Cache) startPreloadTask(ctx context.Context, request PreloadRequest, paused bool) error {
	if request.Mode != "full" && request.Mode != "incremental" {
		return fmt.Errorf("SCAN_MODE_INVALID")
	}
	if c.preload == nil {
		return fmt.Errorf("RUNTIME_OFFLINE")
	}
	if len(request.Platforms) == 0 {
		return fmt.Errorf("SCAN_PLATFORM_INVALID")
	}
	seen := map[string]bool{}
	for _, id := range request.Platforms {
		if c.preload.config.Sources[id] == "" || seen[id] {
			return fmt.Errorf("SCAN_PLATFORM_INVALID")
		}
		seen[id] = true
		for _, author := range request.Authors[id] {
			if id == "Venera" || author == "" || author == "." || author == ".." || strings.ContainsAny(author, `\/:`+"\x00\r\n") {
				return fmt.Errorf("AUTHOR_DIRECTORY_INVALID")
			}
		}
	}
	for id := range request.Authors {
		if !seen[id] {
			return fmt.Errorf("SCAN_PLATFORM_INVALID")
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.scanning {
		return fmt.Errorf("SCAN_IN_USE")
	}
	if c.preload.planning || c.backgroundActive > 0 {
		return fmt.Errorf("THUMBNAILS_IN_USE")
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return err
	}
	tx, err := c.index.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "INSERT OR REPLACE INTO cover_task VALUES (1,?);", string(encoded)); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE cover_state SET paused=?,replan=1 WHERE singleton=1", paused); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if c.preload.cancel != nil {
		c.preload.cancel()
	}
	c.preload.ctx, c.preload.cancel = context.WithCancel(c.ctx)
	c.backgroundPaused = paused
	c.preload.failure = ""
	c.preload.request = request
	c.preload.planning = !paused
	c.preload.restartPlan = paused
	c.ready.Broadcast()
	if !paused {
		select {
		case c.preload.wake <- struct{}{}:
		default:
		}
	}
	return nil
}

func (c *Cache) QueueScannedCovers(ctx context.Context, request PreloadRequest) error {
	c.mu.Lock()
	if c.preload == nil {
		c.mu.Unlock()
		return nil
	}
	previous, paused, restart := c.preload.request, c.backgroundPaused, c.preload.restartPlan
	c.mu.Unlock()
	var pending bool
	if err := c.index.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM cover_jobs WHERE state IN ('pending','running'))").Scan(&pending); err != nil {
		return err
	}
	keepPaused := paused && (pending || restart)
	if keepPaused {
		selection := map[string]map[string]string{}
		for _, task := range []PreloadRequest{previous, request} {
			for _, id := range task.Platforms {
				authors := task.Authors[id]
				current, exists := selection[id]
				if len(authors) == 0 || exists && current == nil {
					selection[id] = nil
					continue
				}
				if current == nil {
					current = map[string]string{}
					selection[id] = current
				}
				for _, author := range authors {
					current[strings.ToLower(author)] = author
				}
			}
		}
		request.Platforms, request.Authors = nil, map[string][]string{}
		for id, authors := range selection {
			request.Platforms = append(request.Platforms, id)
			for _, author := range authors {
				request.Authors[id] = append(request.Authors[id], author)
			}
		}
	}
	return c.startPreloadTask(ctx, request, keepPaused)
}

func (c *Cache) planInventoryCovers(ctx context.Context, p *coverPreload, request PreloadRequest) error {
	catalogPath := filepath.Join(p.config.InstanceRoot, "live", "catalog.sqlite")
	if err := library.NoLinks(catalogPath); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", thumbnailURI(catalogPath, "mode=ro&_pragma=busy_timeout(3000)"))
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	position := "-1"
	facts := filepath.Join(p.config.InstanceRoot, "state", "ntfs-inventory.sqlite")
	if err = library.NoLinks(facts); err != nil {
		return err
	}
	if _, err = os.Stat(facts); err == nil {
		if _, err = db.ExecContext(ctx, "ATTACH DATABASE ? AS inventory", thumbnailURI(facts, "mode=ro")); err != nil {
			return err
		}
		position = `coalesce((SELECT f.position FROM inventory.facts f WHERE f.platform=w.platform_id AND f.author IN ('',CASE WHEN instr(w.relative_path_key,char(92))>0 THEN substr(w.relative_path_key,1,instr(w.relative_path_key,char(92))-1) ELSE w.relative_path_key END) AND f.key=w.relative_path_key||char(92)||m.relative_path_key AND f.size=m.filesystem_size AND f.mtime=m.filesystem_mtime_ns AND f.position>=0 LIMIT 1),-1)`
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = c.index.updateEstimate(ctx, db); err != nil {
		return err
	}
	if _, err = c.index.prune(ctx, p.config, true); err != nil {
		return err
	}
	if err = c.index.evict(ctx); err != nil {
		return err
	}
	if _, err = c.index.db.ExecContext(ctx, "DELETE FROM cover_next"); err != nil {
		return err
	}
	for _, id := range request.Platforms {
		if err = c.planCoverPlatform(ctx, db, p, request, id, position); err != nil {
			return err
		}
	}
	tx, err := c.index.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM cover_jobs;
INSERT INTO cover_jobs SELECT * FROM cover_next;
DELETE FROM cover_next;
UPDATE cover_state SET replan=0 WHERE singleton=1;`); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *Cache) planCoverPlatform(ctx context.Context, db *sql.DB, p *coverPreload, request PreloadRequest, id, position string) error {
	query := `SELECT w.work_id,m.media_id,w.relative_path,m.relative_path,m.filesystem_media_type,m.filesystem_size,m.filesystem_mtime_ns,` + position + `
FROM works w JOIN media m ON m.work_id=w.work_id AND m.media_id=w.cover_media_id
WHERE w.platform_id=?`
	args := []any{id}
	if authors := request.Authors[id]; len(authors) > 0 {
		marks := make([]string, len(authors))
		for i, author := range authors {
			args = append(args, strings.ToLower(author))
			marks[i] = "?"
		}
		query += " AND substr(w.relative_path_key,1,instr(w.relative_path_key,char(92))-1) IN (" + strings.Join(marks, ",") + ")"
	}
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	batch := make([]coverJob, 0, 256)
	for rows.Next() {
		j := coverJob{platform: id, disk: p.disks[id]}
		var work string
		if err = rows.Scan(&j.work, &j.media, &work, &j.mediaRelative, &j.kind, &j.size, &j.mtime, &j.position); err != nil {
			return err
		}
		j.relative = work + `\` + j.mediaRelative
		j.key = imaging.Key(id, j.relative, j.size, j.mtime)
		batch = append(batch, j)
		if len(batch) == cap(batch) {
			if err = c.saveCoverJobs(ctx, batch, request.Mode == "full"); err != nil {
				return err
			}
			batch = batch[:0]
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return c.saveCoverJobs(ctx, batch, request.Mode == "full")
}

func (c *Cache) saveCoverJobs(ctx context.Context, jobs []coverJob, full bool) error {
	if len(jobs) == 0 {
		return nil
	}
	tx, err := c.index.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO cover_next(key,platform,relative,work_id,media_id,kind,size,mtime,disk,position,state,failure,plan,media_relative)
VALUES(?,?,?,?,?,?,?,?,?,?,CASE WHEN ? OR NOT EXISTS(SELECT 1 FROM main.thumbnails WHERE key=? AND short=540) THEN 'pending' ELSE 'done' END,'',?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	planned := time.Now().UnixMilli()
	for _, j := range jobs {
		if _, err = stmt.ExecContext(ctx, j.key, j.platform, j.relative, j.work, j.media, j.kind, j.size, j.mtime, j.disk, j.position, full, j.key, planned, j.mediaRelative); err != nil {
			return err
		}
	}
	return tx.Commit()
}
