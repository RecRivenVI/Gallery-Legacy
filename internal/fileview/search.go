package fileview

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

func (b *Browser) Search(ctx context.Context, root, relative, query string, o Options) (reading.Row, error) {
	if !o.valid(200, false) || protocol.TrimSpace(query) == "" || len(utf16.Encode([]rune(query))) > 256 {
		return nil, media.Failure("FILE_QUERY_INVALID", 400)
	}
	for _, r := range query {
		if r < 32 {
			return nil, media.Failure("FILE_QUERY_INVALID", 400)
		}
	}
	start, err := b.Resolve(root, relative)
	if err != nil {
		return nil, err
	}
	if !start.Info.IsDir() {
		return nil, media.Failure("FILE_DIRECTORY_REQUIRED", 404)
	}
	lower := cases.Lower(language.Und)
	term := lower.String(norm.NFKC.String(query))
	matches, diagnostics := []reading.Row{}, []reading.Row{}
	observed := 0
	truncated := false
	var visit func(string, int) error
	visit = func(rel string, depth int) error {
		if ctx.Err() != nil {
			return media.Failure("REQUEST_CANCELLED", 499)
		}
		if depth > 64 {
			truncated = true
			return nil
		}
		location, err := b.Resolve(root, rel)
		var dir *os.File
		if err == nil {
			dir, err = os.Open(location.Path)
		}
		if err != nil {
			var p *protocol.Error
			if !errors.As(err, &p) || p.Code != "FILE_PLATFORM_EXCLUDED" {
				diagnostics = append(diagnostics, reading.Row{"code": "FILE_DIRECTORY_UNREADABLE"})
			}
			return nil
		}
		defer dir.Close()
		for {
			entries, readErr := dir.ReadDir(128)
			if readErr != nil && readErr != io.EOF {
				return readErr
			}
			for _, entry := range entries {
				if ctx.Err() != nil {
					return media.Failure("REQUEST_CANCELLED", 499)
				}
				observed++
				if observed > 50000 || len(matches) >= 5000 {
					truncated = true
					return nil
				}
				if hidden(entry.Name()) || entry.Type()&os.ModeSymlink != 0 {
					continue
				}
				child := strings.TrimPrefix(rel+"/"+entry.Name(), "/")
				found, err := b.Resolve(root, child)
				if err != nil {
					var p *protocol.Error
					if !errors.As(err, &p) || p.Code != "FILE_PLATFORM_EXCLUDED" {
						diagnostics = append(diagnostics, reading.Row{"code": "FILE_ENTRY_UNAVAILABLE"})
					}
					continue
				}
				kind := library.MediaKind(filepath.Ext(entry.Name()))
				isDir := found.Info.IsDir()
				if (isDir || found.Info.Mode().IsRegular() && kind != "" && (o.Filter == "all" || o.Filter == kind)) && strings.Contains(lower.String(norm.NFKC.String(child)), term) {
					if isDir {
						matches = append(matches, reading.Row{"name": entry.Name(), "relativePath": child, "type": "directory"})
					} else {
						dto, err := fileDTO(root, child, entry.Name(), found.Info)
						if err != nil {
							return err
						}
						matches = append(matches, dto)
					}
				}
				if isDir {
					if err = visit(child, depth+1); err != nil {
						return err
					}
				}
				if truncated && (observed > 50000 || len(matches) >= 5000) {
					return nil
				}
			}
			if readErr == io.EOF {
				return nil
			}
		}
	}
	if err = visit(start.Relative, 0); err != nil {
		return nil, err
	}
	sortRows(matches, "relativePath", o.Order)
	return reading.Row{"rootId": root, "path": start.Relative, "items": slice(matches, o), "total": len(matches), "page": o.Page, "pageSize": o.Size, "totalPages": max(1, (len(matches)+o.Size-1)/o.Size), "observed": observed, "truncated": truncated, "complete": !truncated && len(diagnostics) == 0, "diagnostics": diagnostics[:min(100, len(diagnostics))]}, nil
}
