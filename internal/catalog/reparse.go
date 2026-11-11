package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

type metadataReader func(string, string, int64) ([]byte, os.FileInfo, error)

// ReparseMetadata upgrades enrichment from recorded work paths. It never
// enumerates a source directory or opens/stat's media; media IDs and facts stay.
// Completed works are resumable via their adapter version and details row.
func (w *Writer) ReparseMetadata(ctx context.Context, sources map[string]string) (int64, error) {
	return w.reparseMetadata(ctx, sources, library.ReadSource)
}

func (w *Writer) reparseMetadata(ctx context.Context, sources map[string]string, read metadataReader) (int64, error) {
	var count int64
	definition, err := api.LoadCatalog()
	if err != nil {
		return count, fmt.Errorf("load reparse contract: %w", err)
	}
	for _, platform := range definition.Platforms {
		var after int64
		for {
			var authorID int64
			var author, key string
			err = w.DB.QueryRowContext(ctx, `SELECT a.author_id,a.relative_path,a.relative_path_key FROM authors a WHERE a.platform_id=? AND a.author_id>? AND EXISTS(SELECT 1 FROM works w LEFT JOIN work_details d USING(work_id) WHERE w.author_id=a.author_id AND (w.adapter_version<? OR d.work_id IS NULL)) ORDER BY a.author_id LIMIT 1`, platform.ID, after, platform.AdapterVersion).Scan(&authorID, &author, &key)
			if err == sql.ErrNoRows {
				break
			}
			if err != nil {
				return count, fmt.Errorf("select metadata upgrade author: %w", err)
			}
			n, err := w.reparseAuthor(ctx, platform.ID, author, key, authorID, sources[platform.ID], read)
			count += n
			if err != nil {
				return count, err
			}
			after = authorID
		}
	}
	return count, nil
}

func (w *Writer) reparseAuthor(ctx context.Context, platform, author, key string, authorID int64, root string, read metadataReader) (int64, error) {
	var count, after int64
	var anchor PreparedWork
	for {
		rows, err := w.DB.QueryContext(ctx, `SELECT w.work_id,w.relative_path,w.work_dir_mtime_ns,w.metadata_mtime_ns,w.metadata_size,w.adapter_version,w.image_count,w.video_count,w.media_count,w.cover_media_id,s.fingerprint,p.projection,d.work_id IS NOT NULL FROM works w LEFT JOIN live_scan_works s ON s.platform_id=w.platform_id AND s.relative_path_key=w.relative_path_key LEFT JOIN live_scan_work_profiles p ON p.platform_id=w.platform_id AND p.relative_path_key=w.relative_path_key LEFT JOIN work_details d USING(work_id) WHERE w.author_id=? AND w.work_id>? ORDER BY w.work_id LIMIT 128`, authorID, after)
		if err != nil {
			return count, fmt.Errorf("read upgrade work facts: %w", err)
		}
		type fact struct {
			id, mtime, adapter, images, videos, media int64
			relative                                  string
			metaMtime, metaSize, cover                sql.NullInt64
			signature                                 sql.NullString
			projection                                []byte
			enriched                                  bool
		}
		facts := []fact{}
		for rows.Next() {
			var f fact
			if err = rows.Scan(&f.id, &f.relative, &f.mtime, &f.metaMtime, &f.metaSize, &f.adapter, &f.images, &f.videos, &f.media, &f.cover, &f.signature, &f.projection, &f.enriched); err != nil {
				break
			}
			facts = append(facts, f)
		}
		err = errors.Join(err, rows.Err(), rows.Close())
		if err != nil {
			return count, fmt.Errorf("read upgrade work facts: %w", err)
		}
		if len(facts) == 0 {
			break
		}
		batch := []PreparedWork{}
		for _, f := range facts {
			after = f.id
			if f.enriched && f.adapter >= int64(metadata.Versions[platform]) {
				if len(f.projection) > 0 {
					p, e := DecodeAuthority(f.projection)
					if e != nil {
						return count, e
					}
					if anchor.Key == "" || Later(p, anchor) {
						anchor = p
					}
				}
				continue
			}
			path, e := library.Join(root, f.relative+`\metadata.json`)
			if e != nil {
				return count, fmt.Errorf("metadata upgrade path: %w", e)
			}
			raw, info, e := read(root, path, 64<<20)
			if e != nil && !errors.Is(e, os.ErrNotExist) {
				return count, fmt.Errorf("read metadata upgrade %s/%s: %w", platform, f.relative, e)
			}
			state := "missing"
			r := metadata.New()
			r.Valid = false
			var metaMtime, metaSize any
			if info != nil {
				metaMtime, metaSize = info.ModTime().UnixNano(), info.Size()
			}
			if e == nil {
				var object metadata.Object
				r, object = metadata.Parse(platform, author, filepath.Base(strings.ReplaceAll(f.relative, `\`, string(filepath.Separator))), raw)
				state = "valid"
				if object == nil {
					state = "malformed"
					if r.Reason == "metadata_not_object" {
						state = "non_object"
					}
				} else if !r.Valid || r.InvalidFields > 0 {
					state = "partial"
				}
			}
			signature := ""
			if f.signature.Valid && metaMtime == nullableInt(f.metaMtime) && metaSize == nullableInt(f.metaSize) {
				prefix, raw, ok := strings.Cut(f.signature.String, ":")
				if n := strings.LastIndex(prefix, "-a"); ok && n >= 0 {
					signature = fmt.Sprintf("%s-a%d:%s", prefix[:n], metadata.Versions[platform], raw)
				}
			}
			p := Fill(platform, author, filepath.Base(strings.ReplaceAll(f.relative, `\`, string(filepath.Separator))), f.relative, f.mtime, state, metaMtime, metaSize, r, "", signature, nil)
			p.MetadataOnly = true
			p.Work["image_count"], p.Work["video_count"], p.Work["media_count"], p.Work["cover_media_id"] = f.images, f.videos, f.media, nullableInt(f.cover)
			// Filesystem-only presentation facts (.nocover/archive previews) are
			// already committed and must survive a metadata-only upgrade.
			old, e := w.DB.QueryContext(ctx, "SELECT field,source_kind,source_path,priority FROM field_sources WHERE work_id=? AND source_kind='filesystem' AND field LIKE 'media.%'", f.id)
			if e != nil {
				return count, e
			}
			for old.Next() {
				var field, kind, path string
				var priority int64
				if e = old.Scan(&field, &kind, &path, &priority); e != nil {
					break
				}
				p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": field, "source_kind": kind, "source_path": path, "priority": priority})
			}
			e = errors.Join(e, old.Err(), old.Close())
			if e != nil {
				return count, e
			}
			batch = append(batch, p)
			if anchor.Key == "" || Later(p, anchor) {
				anchor = Authority(p)
			}
		}
		if len(batch) > 0 {
			if _, err = w.BatchWithCompletions(ctx, batch, nil, nil); err != nil {
				return count, fmt.Errorf("commit metadata upgrade: %w", err)
			}
			count += int64(len(batch))
		}
	}
	if anchor.Key != "" {
		_, err := w.BatchWithCompletions(ctx, nil, []AuthorEnd{{Platform: platform, Key: key, Complete: true}}, []PreparedWork{anchor})
		if err != nil {
			return count, fmt.Errorf("finalize metadata upgrade author: %w", err)
		}
	}
	return count, nil
}

func nullableInt(v sql.NullInt64) any {
	if v.Valid {
		return v.Int64
	}
	return nil
}
