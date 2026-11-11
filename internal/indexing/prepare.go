package indexing

import (
	"context"
	"database/sql"
	"errors"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (p *Pipeline) prepare(ctx context.Context, l *library.Listing, read *sql.DB, platform string, author, work library.Entry, release func(), seed *metadataInput) (catalog.PreparedWork, error) {
	var zero catalog.PreparedWork
	root := p.Config.Sources[platform]
	var e error
	defer release()
	if ctx.Err() != nil {
		return zero, ctx.Err()
	}
	tree, e := p.nativeWork(ctx, l, platform, work)
	if e != nil {
		return zero, e
	}
	defer func() {
		if err := tree.Close(); err != nil {
			slog.WarnContext(ctx, "清理作品暂存失败", "platform", platform, "error", err)
		}
	}()
	work.Mtime, e = tree.RootMtime(ctx)
	if e != nil {
		return zero, e
	}
	fingerprint := "file-list-v1"

	if p.Mode == "incremental" && !l.Indexed(platform) {
		identical, err := sameFiles(ctx, read, platform, work.Key, func(accept func(library.Entry) error) error { return tree.Each(ctx, accept) })
		if err != nil {
			return zero, err
		}
		cached, reusable, err := committedWork(ctx, read, platform, work, fingerprint)
		if err != nil {
			return zero, err
		}
		if reusable && identical {
			cached.Work["work_dir_mtime_ns"] = work.Mtime
			if err = p.verifyWork(ctx, platform, tree); err != nil {
				return zero, err
			}
			return cached, nil
		}
	}
	files := []catalog.File{}
	var input *metadataInput
	defer func() { input.close() }()
	var raw []byte
	metaState := "missing"
	var metaMtime, metaSize any
	r := metadata.New()
	r.Valid = false
	shape := ""
	e = tree.Each(ctx, func(entry library.Entry) error {
		if entry.Key == work.Key {
			return nil
		}
		relative := strings.TrimPrefix(entry.Relative, work.Relative+"\\")
		if relative == entry.Relative {
			return errors.New("WORK_SCOPE_ESCAPE")
		}
		if entry.Kind == "folder" {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(entry.Name))
		kind := library.MediaKind(ext)
		if strings.EqualFold(relative, "metadata.json") {
			input = seed
			if input == nil {
				input = p.readMetadata(ctx, platform, entry)
			}
			if input.entry.Size != entry.Size || input.entry.Mtime/100 != entry.Mtime/100 {
				return errors.New("METADATA_CHANGED_SINCE_LISTING")
			}
			var st os.FileInfo
			raw, st, e = input.raw, input.info, input.err
			if st != nil {
				metaMtime, metaSize = st.ModTime().UnixNano(), st.Size()
			}
			if e != nil {
				input.close()
				failure := code(e)
				if failure == "METADATA_CHANGED_DURING_READ" || failure == "METADATA_CHANGED_SINCE_LISTING" || failure == "FILESYSTEM_INCOMPLETE" || strings.HasPrefix(failure, "SOURCE_") || failure == "PATH_REPARSE" {
					return e
				}
				// An unreadable existing file only loses enrichment; a missing or
				// changed listing member still invalidates the complete work.
				if st == nil {
					st, e = p.check(root, entry.Relative)
					if e != nil || !st.Mode().IsRegular() {
						return errors.New("FILESYSTEM_INCOMPLETE")
					}
					if st.Size() != entry.Size || st.ModTime().UnixNano()/100 != entry.Mtime/100 {
						return errors.New("METADATA_CHANGED_SINCE_LISTING")
					}
					metaMtime, metaSize = st.ModTime().UnixNano(), st.Size()
				}
				metaState = "unreadable"
				return nil
			}
			metaState = "read"
			return nil
		}
		if kind != "" {
			p.c.ReusedMediaAttributes.Add(1)
		}
		if tree.DB == nil {
			files = append(files, catalog.File{Relative: relative, Key: strings.ToLower(relative), Name: entry.Name, Extension: ext, Kind: kind, Size: entry.Size, Mtime: entry.Mtime})
		}
		return nil
	})
	if e != nil {
		return zero, e
	}
	// Absence in the provider alone cannot remove a previously committed page.
	rows, e := read.QueryContext(ctx, "SELECT m.relative_path FROM media m JOIN works w USING(work_id) WHERE w.platform_id=? AND w.relative_path_key=?", platform, work.Key)
	if e != nil {
		return zero, e
	}
	for rows.Next() {
		var relative string
		if e = rows.Scan(&relative); e != nil {
			rows.Close()
			return zero, e
		}
		present, checkErr := tree.Contains(ctx, work.Key+"\\"+strings.ToLower(relative))
		if checkErr != nil {
			rows.Close()
			return zero, checkErr
		}
		if !present {
			_, e = p.check(root, work.Relative+"\\"+relative)
			if !os.IsNotExist(e) {
				rows.Close()
				return zero, errors.New("FILESYSTEM_MISSING_EXISTING_MEDIA")
			}
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return zero, e
	}
	if metaState == "missing" {
		_, e = p.check(root, work.Relative+"\\metadata.json")
		if !os.IsNotExist(e) {
			return zero, errors.New("FILESYSTEM_MISSING_METADATA")
		}
	}
	if e = p.verifyWork(ctx, platform, tree); e != nil {
		return zero, e
	}
	release()
	if metaState == "read" {
		parseStart := time.Now()
		var m metadata.Object
		r, m = metadata.Parse(platform, author.Name, work.Name, raw)
		if m != nil {
			metaState = "valid"
			if !r.Valid || r.InvalidFields > 0 {
				metaState = "partial"
			}
			wild := []string{}
			if platform == "微博" {
				wild = []string{"$.pic_infos"}
			}
			if platform == "pixivFANBOX" {
				wild = []string{"$.articleBody.imageMap"}
			}
			shape = metadata.Shape(platform, m, wild, nil, 1)
		} else {
			metaState = "malformed"
			if r.Reason == "metadata_not_object" {
				metaState = "non_object"
			}
		}
		p.c.ParseNanos.Add(time.Since(parseStart).Nanoseconds())
		if m := p.preparation[platform]; m != nil {
			m.Parse.Add(time.Since(parseStart).Nanoseconds())
		}
	}
	largeBody := len(raw) > 4<<20
	raw = nil
	if p.Delay > 0 {
		select {
		case <-time.After(p.Delay):
		case <-ctx.Done():
			return zero, ctx.Err()
		}
	}
	mappingStart := time.Now()
	prepared := catalog.Fill(platform, author.Name, work.Name, work.Relative, work.Mtime, metaState, metaMtime, metaSize, r, shape, processedSignature(platform, fingerprint), files)
	if tree.DB == nil && !largeBody {
		if e = catalog.AttachInventory(ctx, tree, &prepared); e != nil {
			return zero, e
		}
	}
	if !largeBody && tree.DB == nil && prepared.Bytes <= 8<<20 {
		prepared.Bytes = int64(len(metadata.JSON(prepared)))
	}
	if tree.DB != nil || prepared.Bytes > 8<<20 || largeBody {
		seed := catalog.Fill(platform, author.Name, work.Name, work.Relative, work.Mtime, metaState, metaMtime, metaSize, r, shape, processedSignature(platform, fingerprint), nil)
		prepared, e = catalog.PrepareLarge(ctx, tree, seed)
		if e != nil {
			return zero, e
		}
	}
	p.c.MappingNanos.Add(time.Since(mappingStart).Nanoseconds())
	if m := p.preparation[platform]; m != nil {
		m.Mapping.Add(time.Since(mappingStart).Nanoseconds())
	}
	return prepared, nil
}
