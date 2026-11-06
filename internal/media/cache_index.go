package media

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

type thumbnailIndex struct {
	db    *sql.DB
	limit int64
}
type thumbnailEntry struct {
	DurationMs    int64
	Width, Height int
	Hash          []byte
	Original      bool
	Animated      bool
}

func openThumbnailIndex(file string) (*thumbnailIndex, error) {
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(file)}
	q := u.Query()
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(FULL)")
	q.Add("_pragma", "busy_timeout(1500)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, fmt.Errorf("open thumbnail index: %w", err)
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS thumbnails(key TEXT PRIMARY KEY,platform TEXT NOT NULL,relative TEXT NOT NULL,work_relative TEXT NOT NULL,media_relative TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,tier TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,hash BLOB NOT NULL,bytes INTEGER NOT NULL,original INTEGER NOT NULL,animated INTEGER NOT NULL,last_used INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS thumbnails_lru ON thumbnails(tier,last_used);CREATE INDEX IF NOT EXISTS thumbnails_source ON thumbnails(platform,relative);CREATE TABLE IF NOT EXISTS thumbnail_video(key TEXT PRIMARY KEY,duration_ms INTEGER NOT NULL);CREATE TRIGGER IF NOT EXISTS thumbnail_video_remove AFTER DELETE ON thumbnails BEGIN DELETE FROM thumbnail_video WHERE key=old.key; END;DELETE FROM thumbnail_video WHERE key NOT IN (SELECT key FROM thumbnails);`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize thumbnail index: %w", err)
	}
	return &thumbnailIndex{db: db}, nil
}
func (i *thumbnailIndex) lookup(ctx context.Context, key string) (thumbnailEntry, bool, error) {
	var e thumbnailEntry
	var tier string
	var lastUsed int64
	err := i.db.QueryRowContext(ctx, "SELECT width,height,hash,original,animated,tier,last_used,coalesce((SELECT duration_ms FROM thumbnail_video v WHERE v.key=thumbnails.key),0) FROM thumbnails WHERE key=?", key).Scan(&e.Width, &e.Height, &e.Hash, &e.Original, &e.Animated, &tier, &lastUsed, &e.DurationMs)
	if err == sql.ErrNoRows {
		return e, false, nil
	}
	if err != nil {
		return e, false, fmt.Errorf("read thumbnail index: %w", err)
	}
	if tier != "s" && lastUsed < time.Now().Add(-time.Minute).UnixMilli() {
		_, err = i.db.ExecContext(ctx, "UPDATE thumbnails SET last_used=? WHERE key=?", time.Now().UnixMilli(), key)
	}
	return e, true, err
}
func (i *thumbnailIndex) store(ctx context.Context, j *job, p imaging.Preview) error {
	var bytes int64
	if !p.Original {
		st, err := os.Stat(j.target)
		if err != nil {
			return err
		}
		bytes = st.Size()
	}
	relative, err := filepath.Rel(j.file.Root, j.file.Path)
	if err != nil {
		return err
	}
	full := strings.ToLower(strings.ReplaceAll(relative, "/", `\`))
	mediaRelative := strings.ToLower(strings.ReplaceAll(j.file.RelativeKey, "/", `\`))
	workRelative := strings.TrimSuffix(strings.TrimSuffix(full, mediaRelative), `\`)
	tx, err := i.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, "INSERT OR REPLACE INTO thumbnails VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", j.key, j.file.Platform, strings.ToLower(filepath.ToSlash(relative)), workRelative, mediaRelative, j.file.Info.Size(), j.file.Info.ModTime().UnixNano(), j.tier, p.Width, p.Height, p.Hash, bytes, p.Original, p.Animated, time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("store thumbnail index: %w", err)
	}
	if _, err = tx.ExecContext(ctx, "INSERT OR REPLACE INTO thumbnail_video VALUES (?,?)", j.key, p.DurationMs); err != nil {
		return err
	}
	return tx.Commit()
}
func (c *Cache) evict(protect string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var used int64
	if err := c.index.db.QueryRowContext(c.ctx, "SELECT coalesce(sum(bytes),0) FROM thumbnails WHERE tier!='s'").Scan(&used); err != nil {
		return err
	}
	for used > c.index.limit {
		var key string
		var size int64
		query := "SELECT key,bytes FROM thumbnails WHERE tier!='s' AND bytes>0 AND key!=?"
		args := []any{protect}
		for retained := range c.retained {
			query += " AND key!=?"
			args = append(args, retained)
		}
		err := c.index.db.QueryRowContext(c.ctx, query+" ORDER BY last_used LIMIT 1", args...).Scan(&key, &size)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		file := filepath.Join(c.root, key[:2], key[2:4], key+".webp")
		if err = instance.RemoveOwned(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if _, err = c.index.db.ExecContext(c.ctx, "DELETE FROM thumbnails WHERE key=?", key); err != nil {
			return err
		}
		used -= size
	}
	return nil
}

func (c *Cache) retain(key string) func() {
	c.mu.Lock()
	c.retained[key]++
	c.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			c.retained[key]--
			if c.retained[key] == 0 {
				delete(c.retained, key)
			}
			c.ready.Broadcast()
			c.mu.Unlock()
			if c.ctx.Err() == nil {
				if err := c.evict(""); err != nil && c.ctx.Err() == nil {
					slog.WarnContext(c.ctx, "缩略图缓存清理失败", "error", err)
				}
			}
		})
	}
}

// LookupSummary is a cache-only lookup for list responses; it never opens a
// source file to obtain dimensions or a placeholder.
func (c *Cache) LookupSummary(ctx context.Context, key string) (map[string]any, error) {
	e, ok, err := c.index.lookup(ctx, key)
	if err != nil || !ok {
		return nil, err
	}
	return map[string]any{"width": e.Width, "height": e.Height, "thumbHash": base64.StdEncoding.EncodeToString(e.Hash), "animated": e.Animated, "durationMs": e.DurationMs}, nil
}
