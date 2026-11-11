package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

const weiboTitleRule = "weibo-title-object-v1"

type MetadataProgress struct {
	Total      int64 `json:"total"`
	Completed  int64 `json:"completed"`
	Skipped    int64 `json:"skipped"`
	Failed     int64 `json:"failed"`
	TitleTotal int64 `json:"titleTotal"`
	TitleRead  int64 `json:"titleRead"`
}

func (w *Writer) PlanMetadataRefresh(ctx context.Context, sources map[string]string, stateRoot string, retryFailed bool) error {
	if _, err := w.DB.ExecContext(ctx, api.MetadataRefreshSQL); err != nil {
		return fmt.Errorf("initialize metadata refresh: %w", err)
	}
	if err := w.seedMetadataRefresh(ctx, retryFailed); err != nil {
		return err
	}
	if stateRoot != "" {
		if err := w.planMetadataPositions(ctx, sources, stateRoot); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "作品信息升级无法读取磁盘位置", "code", "METADATA_POSITIONS_UNAVAILABLE")
		}
	}
	return ctx.Err()
}

func (w *Writer) seedMetadataRefresh(ctx context.Context, retryFailed bool) error {
	tx, err := w.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for platform, version := range metadata.Versions {
		if _, err = tx.ExecContext(ctx, "INSERT INTO metadata_refresh(work_id,adapter_version) SELECT w.work_id,? FROM works w LEFT JOIN work_details d USING(work_id) WHERE w.platform_id=? AND (w.adapter_version<? OR d.work_id IS NULL) ON CONFLICT(work_id) DO UPDATE SET adapter_version=excluded.adapter_version,state='pending' WHERE excluded.adapter_version>metadata_refresh.adapter_version", version, platform, version); err != nil {
			return fmt.Errorf("select versioned metadata refresh: %w", err)
		}
	}
	if err = seedWeiboTitleRefresh(ctx, tx); err != nil {
		return err
	}
	if retryFailed {
		if _, err = tx.ExecContext(ctx, "UPDATE metadata_refresh SET state='pending' WHERE state='failed'"); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func seedWeiboTitleRefresh(ctx context.Context, tx *sql.Tx) error {
	var seeded bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM metadata_refresh_rules WHERE name=?)", weiboTitleRule).Scan(&seeded); err != nil || seeded {
		return err
	}
	// Reused scan warnings are produced from these same committed projections.
	// The current scan's JSONL is overwritten by the next scan.
	rows, err := tx.QueryContext(ctx, "SELECT w.work_id,p.projection FROM works w JOIN live_scan_work_profiles p ON p.platform_id=w.platform_id AND p.relative_path_key=w.relative_path_key WHERE w.platform_id='微博' AND w.metadata_state='partial'")
	if err != nil {
		return err
	}
	var selected []int64
	for rows.Next() {
		var id int64
		var blob []byte
		if err = rows.Scan(&id, &blob); err != nil {
			break
		}
		var projection PreparedWork
		projection, err = DecodeAuthority(blob)
		if err != nil {
			break
		}
		if hasWeiboTitleIssue(projection) {
			selected = append(selected, id)
		}
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return fmt.Errorf("read committed Weibo title diagnostics: %w", err)
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO metadata_refresh(work_id,adapter_version,title_fix) VALUES(?,?,1) ON CONFLICT(work_id) DO UPDATE SET title_fix=1,state='pending'")
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, id := range selected {
		if _, err = stmt.ExecContext(ctx, id, metadata.Versions["微博"]); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO metadata_refresh_rules VALUES(?)", weiboTitleRule)
	return err
}

func hasWeiboTitleIssue(projection PreparedWork) bool {
	for _, issue := range projection.Normalized.Issues {
		if issue.Path == "$.title" && issue.Reason == "unsupported_value" {
			return true
		}
	}
	return false
}

func (w *Writer) planMetadataPositions(ctx context.Context, sources map[string]string, stateRoot string) (result error) {
	var slow []string
	for platform, root := range sources {
		_, limit := library.Disk(root)
		if limit == 2 {
			slow = append(slow, platform)
		}
	}
	if len(slow) == 0 {
		return nil
	}
	file := filepath.Join(stateRoot, "ntfs-inventory.sqlite")
	if err := library.NoLinks(file); err != nil {
		return err
	}
	if _, err := os.Stat(file); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	conn, err := w.DB.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	uri := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(file), RawQuery: "mode=ro"}
	if _, err = conn.ExecContext(ctx, "ATTACH DATABASE ? AS metadata_inventory", uri.String()); err != nil {
		return err
	}
	defer func() {
		_, err := conn.ExecContext(context.WithoutCancel(ctx), "DETACH DATABASE metadata_inventory")
		result = errors.Join(result, err)
	}()
	for _, platform := range slow {
		_, err = conn.ExecContext(ctx, "UPDATE metadata_refresh SET position=coalesce((SELECT f.position FROM works w JOIN metadata_inventory.facts f ON f.platform=w.platform_id AND f.author='' AND f.key=w.relative_path_key||char(92)||'metadata.json' AND f.size=w.metadata_size AND f.mtime=w.metadata_mtime_ns JOIN metadata_inventory.scope s ON s.platform=f.platform AND s.author=f.author WHERE w.work_id=metadata_refresh.work_id AND s.root_path=?),-1) WHERE state='pending' AND work_id IN (SELECT work_id FROM works WHERE platform_id=?)", strings.ToLower(filepath.Clean(sources[platform])), platform)
		if err != nil {
			return err
		}
	}
	return nil
}

func (w *Writer) MetadataProgress(ctx context.Context) (MetadataProgress, error) {
	var p MetadataProgress
	err := w.DB.QueryRowContext(ctx, "SELECT count(*),count(*) FILTER(WHERE state='done'),count(*) FILTER(WHERE state='skipped'),count(*) FILTER(WHERE state='failed'),count(*) FILTER(WHERE title_fix=1),count(*) FILTER(WHERE title_fix=1 AND state IN ('done','failed')) FROM metadata_refresh").Scan(&p.Total, &p.Completed, &p.Skipped, &p.Failed, &p.TitleTotal, &p.TitleRead)
	return p, err
}

func (w *Writer) nextMetadataRefresh(ctx context.Context) ([]refreshFact, error) {
	rows, err := w.DB.QueryContext(ctx, "SELECT w.work_id,w.platform_id,a.relative_path,w.relative_path,w.work_dir_mtime_ns,w.metadata_mtime_ns,w.metadata_size,w.image_count,w.video_count,w.media_count,w.cover_media_id,s.fingerprint,CASE WHEN j.title_fix=1 THEN p.projection END,w.adapter_version<j.adapter_version OR d.work_id IS NULL,j.title_fix FROM metadata_refresh j JOIN works w USING(work_id) JOIN authors a USING(author_id) LEFT JOIN live_scan_works s ON s.platform_id=w.platform_id AND s.relative_path_key=w.relative_path_key LEFT JOIN live_scan_work_profiles p ON p.platform_id=w.platform_id AND p.relative_path_key=w.relative_path_key LEFT JOIN work_details d USING(work_id) WHERE j.state='pending' ORDER BY (j.position<0),j.position,j.work_id LIMIT 32")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	facts := make([]refreshFact, 0, 32)
	for rows.Next() {
		var f refreshFact
		if err := rows.Scan(&f.id, &f.platform, &f.author, &f.relative, &f.mtime, &f.metaMtime, &f.metaSize, &f.images, &f.videos, &f.media, &f.cover, &f.signature, &f.projection, &f.generic, &f.titleFix); err != nil {
			return nil, err
		}
		facts = append(facts, f)
	}
	return facts, rows.Err()
}

func (w *Writer) setMetadataRefreshState(ctx context.Context, id int64, state string) error {
	_, err := w.DB.ExecContext(ctx, "UPDATE metadata_refresh SET state=? WHERE work_id=?", state, id)
	return err
}

func rememberMetadataAuthor(t *transaction, authorID int64, p PreparedWork) error {
	var blob []byte
	err := t.get("SELECT projection FROM metadata_refresh_authors WHERE author_id=?", authorID).Scan(&blob)
	if err == nil {
		best, err := DecodeAuthority(blob)
		if err != nil || !Later(p, best) {
			return err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	blob, err = EncodeAuthority(p)
	if err != nil {
		return err
	}
	return t.exec("INSERT OR REPLACE INTO metadata_refresh_authors VALUES(?,?)", authorID, blob)
}

func (w *Writer) finalizeMetadataAuthors(ctx context.Context) error {
	for {
		var authorID int64
		var blob []byte
		err := w.DB.QueryRowContext(ctx, "SELECT author_id,projection FROM metadata_refresh_authors ORDER BY author_id LIMIT 1").Scan(&authorID, &blob)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		best, err := DecodeAuthority(blob)
		if err != nil {
			return err
		}
		var present bool
		if err = w.DB.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM works WHERE author_id=? AND relative_path_key=?)", authorID, best.Key).Scan(&present); err != nil {
			return err
		}
		err = w.DB.QueryRowContext(ctx, "SELECT p.projection FROM works w JOIN live_scan_works s ON s.platform_id=w.platform_id AND s.relative_path_key=w.relative_path_key JOIN live_scan_work_profiles p ON p.platform_id=w.platform_id AND p.relative_path_key=w.relative_path_key WHERE w.author_id=? ORDER BY s.authority_at_ms DESC,s.authority_source_id DESC,w.relative_path DESC LIMIT 1", authorID).Scan(&blob)
		if err == nil {
			current, err := DecodeAuthority(blob)
			if err != nil {
				return err
			}
			if !present || current.Key == best.Key || Later(current, best) {
				best = current
			}
			present = true
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if present {
			if _, err = w.BatchWithCompletions(ctx, nil, []AuthorEnd{{Platform: best.Platform, Key: best.AuthorKey, Complete: true}}, []PreparedWork{best}); err != nil {
				return fmt.Errorf("finalize metadata refresh author: %w", err)
			}
		}
		if _, err = w.DB.ExecContext(ctx, "DELETE FROM metadata_refresh_authors WHERE author_id=?", authorID); err != nil {
			return err
		}
	}
}
