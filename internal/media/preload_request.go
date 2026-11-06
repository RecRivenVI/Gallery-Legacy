package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/mediaorder"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type PreloadRequest struct {
	Mode        string              `json:"mode"`
	Platforms   []string            `json:"platformIds"`
	Authors     map[string][]string `json:"authors"`
	AllowNative bool                `json:"allowNative"`
}

func (c *Cache) StartPreloadTask(ctx context.Context, request PreloadRequest) error {
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
	if !request.AllowNative {
		if err := library.LocalEverything().Available(ctx); err != nil {
			return fmt.Errorf("EVERYTHING_CONFIRMATION_REQUIRED: %w", err)
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
	if c.preload.cancel != nil {
		c.preload.cancel()
	}
	c.preload.ctx, c.preload.cancel = context.WithCancel(c.ctx)
	c.backgroundPaused = false
	c.ready.Broadcast()
	encoded, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if _, err = c.index.db.ExecContext(c.ctx, "INSERT OR REPLACE INTO cover_task VALUES (1,?);", string(encoded)); err != nil {
		return err
	}
	if _, err = c.index.db.ExecContext(c.ctx, "UPDATE cover_state SET paused=0 WHERE singleton=1"); err != nil {
		return err
	}
	c.preload.failure = ""
	c.preload.request = request
	c.preload.planning = true
	select {
	case c.preload.wake <- struct{}{}:
	default:
	}
	return nil
}

func (c *Cache) planInventoryCovers(ctx context.Context, p *coverPreload, request PreloadRequest) error {
	if _, err := c.index.db.ExecContext(ctx, "DELETE FROM cover_jobs"); err != nil {
		return err
	}
	listing, err := library.NewListing(p.config.TempRoot)
	if err != nil {
		return err
	}
	defer listing.Close()
	for _, id := range request.Platforms {
		if _, err = listing.LoadEverything(ctx, library.LocalEverything(), id, p.config.Sources[id]); err != nil {
			if !request.AllowNative {
				return fmt.Errorf("EVERYTHING_CONFIRMATION_REQUIRED: %w", err)
			}
			if err = listing.Reset(ctx, id); err != nil {
				return err
			}
			if err = listing.LoadNative(ctx, id, p.config.Sources[id]); err != nil {
				return err
			}
		}
		rows, err := listing.DB.QueryContext(ctx, `SELECT key,relative,name,size,mtime,author,work,parent FROM entries WHERE platform=? AND kind='file' AND work<>'' ORDER BY work,key`, id)
		if err != nil {
			return err
		}
		selected := map[string]bool{}
		for _, author := range request.Authors[id] {
			selected[strings.ToLower(author)] = true
		}
		if err = c.saveCoverInventory(ctx, listing, id, selected, time.Now().UnixNano()); err != nil {
			return err
		}
		current := ""
		disabled, previews := false, false
		var chosen mediaorder.Cover
		var job coverJob
		save := func() error {
			if job.relative == "" || disabled {
				return nil
			}
			job.key = imaging.Key(id, job.relative, job.size, job.mtime, "s")
			job.disk = p.disks[id]
			state := "pending"
			if request.Mode == "incremental" {
				var exists int
				if err := c.index.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM thumbnails WHERE key=?)", job.key).Scan(&exists); err != nil {
					return err
				}
				if exists == 1 {
					state = "done"
				}
			}
			if request.Mode == "full" {
				if err := c.discardCover(ctx, job.key); err != nil {
					return err
				}
			}
			_, err := c.index.db.ExecContext(ctx, `INSERT INTO cover_jobs(key,platform,relative,work_id,media_id,kind,size,mtime,disk,state,plan,media_relative) VALUES(?,?,?,0,0,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,plan=excluded.plan`, job.key, id, job.relative, job.kind, job.size, job.mtime, job.disk, state, time.Now().UnixNano(), job.mediaRelative)
			return err
		}
		for rows.Next() {
			var key, relative, name, author, work, parent string
			var size, mtime int64
			if err = rows.Scan(&key, &relative, &name, &size, &mtime, &author, &work, &parent); err != nil {
				break
			}
			if work == key {
				work = parent
			}
			if len(selected) > 0 && !selected[author] {
				continue
			}
			if current != work {
				if err = save(); err != nil {
					break
				}
				current = work
				disabled = false
				previews = false
				if id == "Gank" {
					var archive int
					patterns := []string{}
					args := []any{id, work + `\`, work + `]`}
					for _, ext := range library.ArchiveExtensions() {
						patterns = append(patterns, "lower(name) GLOB ?")
						args = append(args, "*."+ext)
					}
					query := "SELECT EXISTS(SELECT 1 FROM entries WHERE platform=? AND key>? AND key<? AND (" + strings.Join(patterns, " OR ") + "))"
					if err = listing.DB.QueryRowContext(ctx, query, args...).Scan(&archive); err != nil {
						break
					}
					previews = archive == 1
				}
				chosen = mediaorder.Cover{}
				job = coverJob{}
			}
			if strings.EqualFold(relative, work+`\.nocover`) {
				disabled = true
			}
			kind := library.MediaKind(filepath.Ext(name))
			if kind == "" {
				continue
			}
			candidate := mediaorder.Cover{ID: 1, Kind: kind, Name: name, Relative: relative}
			if mediaorder.Better(candidate, chosen, previews) {
				chosen = candidate
				job = coverJob{platform: id, relative: relative, kind: kind, size: size, mtime: mtime, mediaRelative: relative[len(work)+1:]}
			}
		}
		err = errors.Join(err, rows.Err(), rows.Close())
		if err != nil {
			return err
		}
		if err = save(); err != nil {
			return err
		}
	}
	return c.orderCovers(ctx, p)
}

func (c *Cache) discardCover(ctx context.Context, key string) error {
	c.mu.Lock()
	for c.retained[key] > 0 && ctx.Err() == nil {
		c.ready.Wait()
	}
	if err := ctx.Err(); err != nil {
		c.mu.Unlock()
		return err
	}
	defer c.mu.Unlock()

	if err := os.RemoveAll(filepath.Join(c.root, key[:2], key[2:4], key+".webp")); err != nil {
		return err
	}
	_, err := c.index.db.ExecContext(ctx, "DELETE FROM thumbnails WHERE key=?", key)
	return err
}
