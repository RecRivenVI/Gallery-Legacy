package media

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

const (
	Display = "display"
	Strip   = "strip"
)

type thumbnailIndex struct {
	db       *sql.DB
	root     string
	estimate atomic.Int64
}

type thumbnailEntry struct {
	DurationMs    int64
	Width, Height int
	Hash, Data    []byte
	Animated      bool
	Short         int
}

func thumbnailURI(file, mode string) string {
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(file), RawQuery: mode}
	return u.String()
}

func openThumbnailIndex(root string) (*thumbnailIndex, error) {
	covers, previews := filepath.Join(root, "covers.sqlite"), filepath.Join(root, "previews.sqlite")
	for _, path := range []string{covers, previews} {
		if err := library.NoLinks(path); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", thumbnailURI(covers, "_pragma=busy_timeout(3000)&_pragma=synchronous(FULL)&_pragma=journal_mode(WAL)"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("ATTACH DATABASE ? AS preview", thumbnailURI(previews, "")); err != nil {
		db.Close()
		return nil, fmt.Errorf("open preview database: %w", err)
	}
	if _, err = db.Exec("PRAGMA preview.journal_mode=WAL; PRAGMA preview.synchronous=FULL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("configure preview database: %w", err)
	}
	for _, name := range []string{"main", "preview"} {
		if err = initThumbnails(db, name); err != nil {
			db.Close()
			return nil, err
		}
	}
	return &thumbnailIndex{db: db, root: root}, nil
}

func initThumbnails(db *sql.DB, name string) error {
	sql := strings.ReplaceAll(`CREATE TABLE IF NOT EXISTS $db.thumbnails(key TEXT PRIMARY KEY,platform TEXT NOT NULL,relative TEXT NOT NULL,media TEXT NOT NULL,source_size INTEGER NOT NULL,mtime INTEGER NOT NULL,short INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,hash BLOB NOT NULL,duration_ms INTEGER NOT NULL,animated INTEGER NOT NULL,image BLOB NOT NULL,last_used INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS $db.thumbnail_source ON thumbnails(platform,relative);
CREATE INDEX IF NOT EXISTS $db.thumbnail_lru ON thumbnails(last_used,key);
CREATE TABLE IF NOT EXISTS $db.cache_totals(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL);
INSERT OR IGNORE INTO $db.cache_totals VALUES(1,0);
CREATE TRIGGER IF NOT EXISTS $db.thumbnail_insert AFTER INSERT ON thumbnails BEGIN UPDATE cache_totals SET bytes=bytes+length(new.image) WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS $db.thumbnail_delete AFTER DELETE ON thumbnails BEGIN UPDATE cache_totals SET bytes=bytes-length(old.image) WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS $db.thumbnail_resize AFTER UPDATE OF image ON thumbnails BEGIN UPDATE cache_totals SET bytes=bytes+length(new.image)-length(old.image) WHERE singleton=1; END;`, "$db", name)
	if _, err := db.Exec(sql); err != nil {
		return fmt.Errorf("initialize thumbnail database: %w", err)
	}
	return nil
}

func thumbTable(cover bool) string {
	if cover {
		return "main.thumbnails"
	}
	return "preview.thumbnails"
}

func targetShort(tier string) int {
	if tier == Strip {
		return 144
	}
	return 540
}

func (i *thumbnailIndex) lookup(ctx context.Context, key string, cover, includeData bool) (thumbnailEntry, bool, error) {
	var e thumbnailEntry
	columns := "width,height,hash,animated,duration_ms,short"
	dest := []any{&e.Width, &e.Height, &e.Hash, &e.Animated, &e.DurationMs, &e.Short}
	if includeData {
		columns += ",image"
		dest = append(dest, &e.Data)
	}
	err := i.db.QueryRowContext(ctx, "SELECT "+columns+" FROM "+thumbTable(cover)+" WHERE key=?", key).Scan(dest...)
	if errors.Is(err, sql.ErrNoRows) {
		return e, false, nil
	}
	return e, err == nil, err
}

func (i *thumbnailIndex) touch(ctx context.Context, key string) error {
	now := time.Now().UnixMilli()
	_, err := i.db.ExecContext(ctx, "UPDATE preview.thumbnails SET last_used=? WHERE key=? AND last_used<?", now, key, now-30000)
	return err
}

func storeThumbnail(ctx context.Context, tx *sql.Tx, j *job, p imaging.Preview, data []byte) error {
	if len(data) == 0 {
		return errors.New("THUMBNAIL_RENDER_EMPTY")
	}
	relative, err := filepath.Rel(j.file.Root, j.file.Path)
	if err != nil {
		return err
	}
	table := thumbTable(j.file.Cover)
	if _, err = tx.ExecContext(ctx, "INSERT INTO "+table+"(key,platform,relative,media,source_size,mtime,short,width,height,hash,duration_ms,animated,image,last_used) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET media=excluded.media,short=excluded.short,width=excluded.width,height=excluded.height,hash=excluded.hash,duration_ms=excluded.duration_ms,animated=excluded.animated,image=excluded.image,last_used=excluded.last_used WHERE excluded.short>=thumbnails.short",
		j.key, j.file.Platform, strings.ToLower(filepath.ToSlash(relative)), j.file.MediaID, j.file.Info.Size(), j.file.Info.ModTime().UnixNano(), targetShort(j.tier), p.Width, p.Height, p.Hash, p.DurationMs, p.Animated, data, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("store thumbnail: %w", err)
	}
	return nil
}

func (i *thumbnailIndex) retire(ctx context.Context, key, platform, relative string, cover bool) error {
	if _, err := i.db.ExecContext(ctx, "DELETE FROM "+thumbTable(!cover)+" WHERE platform=? AND relative=?", platform, relative); err != nil {
		return err
	}
	_, err := i.db.ExecContext(ctx, "DELETE FROM "+thumbTable(cover)+" WHERE platform=? AND relative=? AND key<>?", platform, relative, key)
	return err
}

func (i *thumbnailIndex) move(ctx context.Context, key string, cover bool) error {
	_, err := i.db.ExecContext(ctx, "INSERT INTO "+thumbTable(cover)+" SELECT * FROM "+thumbTable(!cover)+" WHERE key=? ON CONFLICT(key) DO UPDATE SET short=excluded.short,width=excluded.width,height=excluded.height,hash=excluded.hash,duration_ms=excluded.duration_ms,animated=excluded.animated,image=excluded.image,last_used=excluded.last_used WHERE excluded.short>thumbnails.short", key)
	return err
}

func (i *thumbnailIndex) updateEstimate(ctx context.Context, db *sql.DB) error {
	var covers int64
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM works WHERE cover_media_id IS NOT NULL").Scan(&covers); err != nil {
		return err
	}
	i.estimate.Store(covers * (48 << 10))
	return nil
}

func (i *thumbnailIndex) evict(ctx context.Context) error {
	_, err := i.db.ExecContext(ctx, `WITH victims AS (
 SELECT key,coalesce(sum(length(image)) OVER(ORDER BY last_used,key ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) prior
 FROM preview.thumbnails WHERE (SELECT bytes FROM preview.cache_totals)>max((SELECT bytes FROM main.cache_totals),?)
)
DELETE FROM preview.thumbnails WHERE key IN (
 SELECT key FROM victims WHERE prior<(SELECT bytes FROM preview.cache_totals)-max((SELECT bytes FROM main.cache_totals),?)
)`, i.estimate.Load(), i.estimate.Load())
	return err
}

func (i *thumbnailIndex) occupancy(ctx context.Context) (map[string]any, error) {
	var cover, preview int64
	if err := i.db.QueryRowContext(ctx, "SELECT (SELECT bytes FROM main.cache_totals),(SELECT bytes FROM preview.cache_totals)").Scan(&cover, &preview); err != nil {
		return nil, err
	}
	value := map[string]any{"coverImageBytes": cover, "previewImageBytes": preview, "previewLimitBytes": max(cover, i.estimate.Load())}
	for name, filename := range map[string]string{"cover": "covers.sqlite", "preview": "previews.sqlite"} {
		for field, suffix := range map[string]string{"DatabaseBytes": "", "WALBytes": "-wal"} {
			size := int64(0)
			if stat, err := os.Stat(filepath.Join(i.root, filename+suffix)); err == nil {
				size = stat.Size()
			} else if !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			value[name+field] = size
		}
	}
	return value, nil
}

func (e thumbnailEntry) summary() map[string]any {
	return map[string]any{"width": e.Width, "height": e.Height, "thumbHash": base64.StdEncoding.EncodeToString(e.Hash), "animated": e.Animated, "durationMs": e.DurationMs}
}

// LookupSummary never loads an image BLOB or opens the source.
func (c *Cache) LookupSummary(ctx context.Context, key string) (map[string]any, error) {
	for _, cover := range []bool{true, false} {
		e, ok, err := c.index.lookup(ctx, key, cover, false)
		if ok {
			return e.summary(), err
		}
		if err != nil {
			return nil, err
		}
	}
	return nil, nil
}
