package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

type metadataReader func(string, string, int64) ([]byte, os.FileInfo, error)

type refreshFact struct {
	id, mtime, images, videos, media int64
	platform, author, relative       string
	metaMtime, metaSize, cover       sql.NullInt64
	signature                        sql.NullString
	projection                       []byte
	generic, titleFix                bool
}

func (w *Writer) ReparseMetadata(ctx context.Context, sources map[string]string, progress func(MetadataProgress)) error {
	_, err := w.runMetadataRefresh(ctx, sources, library.ReadSource, progress)
	return err
}

func (w *Writer) runMetadataRefresh(ctx context.Context, sources map[string]string, read metadataReader, notify func(MetadataProgress)) (count int64, err error) {
	progress, err := w.MetadataProgress(ctx)
	if err != nil {
		return 0, err
	}
	notify(progress)
	for {
		facts, err := w.nextMetadataRefresh(ctx)
		if err != nil {
			return count, err
		}
		if len(facts) == 0 {
			break
		}
		batch := make([]PreparedWork, 0, len(facts))
		var target int64
		for _, fact := range facts {
			if err = ctx.Err(); err != nil {
				return count, err
			}
			refresh := fact.generic
			if !refresh && fact.titleFix && len(fact.projection) > 0 {
				p, decodeErr := DecodeAuthority(fact.projection)
				if decodeErr != nil {
					return count, decodeErr
				}
				refresh = hasWeiboTitleIssue(p)
			}
			if !refresh {
				if err = w.setMetadataRefreshState(ctx, fact.id, "skipped"); err != nil {
					return count, err
				}
				progress.Skipped++
				continue
			}
			p, sourceErr, err := w.prepareMetadataRefresh(ctx, fact, sources[fact.platform], read)
			if err != nil {
				return count, err
			}
			if err = ctx.Err(); err != nil {
				return count, err
			}
			if sourceErr != nil {
				if err = w.setMetadataRefreshState(ctx, fact.id, "failed"); err != nil {
					return count, err
				}
				progress.Failed++
				if fact.titleFix {
					progress.TitleRead++
				}
				continue
			}
			batch = append(batch, p)
			if fact.titleFix {
				target++
			}
		}
		if len(batch) > 0 {
			if _, err = w.BatchWithCompletions(ctx, batch, nil, nil); err != nil {
				return count, fmt.Errorf("commit metadata refresh: %w", err)
			}
		}
		count += int64(len(batch))
		progress.Completed += int64(len(batch))
		progress.TitleRead += target
		notify(progress)
	}
	return count, w.finalizeMetadataAuthors(ctx)
}

func (w *Writer) prepareMetadataRefresh(ctx context.Context, f refreshFact, root string, read metadataReader) (PreparedWork, error, error) {
	var zero PreparedWork
	path, err := library.Join(root, f.relative+"\\metadata.json")
	if err != nil {
		return zero, err, nil
	}
	raw, info, err := read(root, path, 64<<20)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return zero, err, nil
	}
	result := metadata.New()
	state := "missing"
	result.Valid = false
	var metaMtime, metaSize any
	if info != nil {
		metaMtime, metaSize = info.ModTime().UnixNano(), info.Size()
	}
	work := filepath.Base(strings.ReplaceAll(f.relative, "\\", string(filepath.Separator)))
	if err == nil {
		var object metadata.Object
		result, object = metadata.Parse(f.platform, f.author, work, raw)
		switch {
		case object == nil && result.Reason == "metadata_not_object":
			state = "non_object"
		case object == nil:
			state = "malformed"
		case !result.Valid || result.InvalidFields > 0:
			state = "partial"
		default:
			state = "valid"
		}
	}
	signature := ""
	if f.signature.Valid && metaMtime == nullableInt(f.metaMtime) && metaSize == nullableInt(f.metaSize) {
		prefix, raw, ok := strings.Cut(f.signature.String, ":")
		if n := strings.LastIndex(prefix, "-a"); ok && n >= 0 {
			signature = fmt.Sprintf("%s-a%d:%s", prefix[:n], metadata.Versions[f.platform], raw)
		}
	}
	p := Fill(f.platform, f.author, work, f.relative, f.mtime, state, metaMtime, metaSize, result, "", signature, nil)
	p.MetadataOnly, p.RefreshPending = true, true
	p.Work["image_count"], p.Work["video_count"], p.Work["media_count"], p.Work["cover_media_id"] = f.images, f.videos, f.media, nullableInt(f.cover)
	rows, err := w.DB.QueryContext(ctx, "SELECT field,source_kind,source_path,priority FROM field_sources WHERE work_id=? AND source_kind='filesystem' AND field LIKE 'media.%'", f.id)
	if err != nil {
		return zero, nil, err
	}
	for rows.Next() {
		var field, kind, path string
		var priority int64
		if err = rows.Scan(&field, &kind, &path, &priority); err != nil {
			break
		}
		p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": field, "source_kind": kind, "source_path": path, "priority": priority})
	}
	return p, nil, errors.Join(err, rows.Err(), rows.Close())
}

func nullableInt(v sql.NullInt64) any {
	if v.Valid {
		return v.Int64
	}
	return nil
}
