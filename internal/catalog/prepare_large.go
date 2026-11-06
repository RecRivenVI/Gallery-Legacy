package catalog

import (
	"context"

	"errors"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func FileFromEntry(work string, e library.Entry) (File, error) {
	relative := strings.TrimPrefix(e.Relative, work+`\`)
	if relative == e.Relative {
		return File{}, errors.New("WORK_SCOPE_ESCAPE")
	}
	ext := strings.ToLower(filepath.Ext(e.Name))
	return File{Relative: relative, Key: strings.ToLower(relative), Name: e.Name, Extension: ext, Kind: library.MediaKind(ext), Size: e.Size, Mtime: e.Mtime}, nil
}

func PrepareLarge(ctx context.Context, tree *library.WorkTree, p PreparedWork) (PreparedWork, error) {
	if err := tree.Spill(ctx); err != nil {
		return p, err
	}
	tx, err := tree.DB.BeginTx(ctx, nil)
	if err != nil {
		return p, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `CREATE TABLE stage_files(key TEXT PRIMARY KEY,relative TEXT,name TEXT,ext TEXT,kind TEXT,size INTEGER,mtime INTEGER);
`)
	if err != nil {
		return p, err
	}
	insert, err := tx.PrepareContext(ctx, "INSERT INTO stage_files VALUES (?,?,?,?,?,?,?)")
	if err != nil {
		return p, err
	}
	defer insert.Close()
	extracted := false
	err = tree.Each(ctx, func(e library.Entry) error {
		if e.Kind != "file" {
			return nil
		}
		f, err := FileFromEntry(text(p.Work["relative_path"]), e)
		if err != nil {
			return err
		}
		if strings.EqualFold(f.Relative, "metadata.json") {
			return nil
		}
		if strings.EqualFold(f.Relative, ".nocover") {
			p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": "media.coverDisabled", "source_kind": "filesystem", "source_path": f.Relative, "priority": 1})
		}
		if !extracted && library.IsArchive(f.Extension) {
			extracted = true
			p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": "files.archivePresent", "source_kind": "filesystem", "source_path": f.Relative, "priority": 1})
			if p.Platform == "Gank" {
				p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": "media.extractedPreviews", "source_kind": "filesystem", "source_path": f.Relative, "priority": 1})
			}
		}
		if f.Kind != "" {
			p.Work[f.Kind+"_count"] = integer(p.Work[f.Kind+"_count"]) + 1
		}
		_, err = insert.ExecContext(ctx, f.Key, f.Relative, f.Name, f.Extension, f.Kind, f.Size, f.Mtime)
		return err
	})
	if err != nil {
		return p, err
	}
	p.Work["media_count"] = integer(p.Work["image_count"]) + integer(p.Work["video_count"])

	rows, err := tx.QueryContext(ctx, "SELECT f.key,f.relative,f.name,f.ext,f.kind,f.size,f.mtime FROM stage_files f WHERE f.kind IN ('image','video') ORDER BY f.key")
	if err != nil {
		return p, err
	}
	ordinal := 0
	for rows.Next() {
		var f File
		if err = rows.Scan(&f.Key, &f.Relative, &f.Name, &f.Extension, &f.Kind, &f.Size, &f.Mtime); err != nil {
			rows.Close()
			return p, err
		}
		m := mediaRow(f)

		if err = stageRow(tx, ctx, "media", ordinal, m); err != nil {
			rows.Close()
			return p, err
		}
		ordinal++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return p, err
	}
	inventoryOrdinal := 0
	if p.Qualified {
		if err = tree.Each(ctx, func(e library.Entry) error {
			if e.Kind != "file" {
				return nil
			}
			err := stageRow(tx, ctx, "live_scan_files", inventoryOrdinal, inventoryRow(e))
			inventoryOrdinal++
			return err
		}); err != nil {
			return p, err
		}
	}
	if err = tx.Commit(); err != nil {
		return p, err
	}
	if err = sealPrepared(ctx, tree.DB, &p); err != nil {
		return p, err
	}
	p.StageFile, err = tree.Detach()
	return p, err
}
