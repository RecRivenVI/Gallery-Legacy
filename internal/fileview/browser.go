// Package fileview browses only explicitly configured, non-platform file roots.
package fileview

import (
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

type Browser struct{ Config instance.Config }
type Location struct {
	Root           instance.FileRoot
	Relative, Path string
	Info           os.FileInfo
}

func (b *Browser) Roots() []reading.Row {
	r := []reading.Row{}
	for _, root := range b.Config.FileBrowserRoots {
		r = append(r, reading.Row{"id": root.ID, "name": root.Name})
	}
	return r
}
func (b *Browser) Resolve(rootID, relative string) (Location, error) {
	var out Location
	found := false
	for _, r := range b.Config.FileBrowserRoots {
		if r.ID == rootID {
			out.Root = r
			found = true
			break
		}
	}
	if !found {
		return out, media.Failure("FILE_ROOT_NOT_FOUND", 404)
	}
	if len(utf16.Encode([]rune(relative))) > 8192 || strings.ContainsRune(relative, ':') {
		return out, media.Failure("FILE_PATH_INVALID", 400)
	}
	for _, r := range relative {
		if r < 32 {
			return out, media.Failure("FILE_PATH_INVALID", 400)
		}
	}
	if relative != "" {
		var err error
		relative, err = media.Relative(relative)
		if err != nil {
			return out, media.Failure("FILE_PATH_INVALID", 400)
		}
	}
	for _, part := range strings.Split(relative, "/") {
		if strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return out, media.Failure("FILE_PATH_INVALID", 400)
		}
	}
	out.Relative = relative
	out.Path = filepath.Join(out.Root.PhysicalRoot, filepath.FromSlash(relative))
	if !library.Inside(out.Root.PhysicalRoot, out.Path) {
		return out, media.Failure("FILE_PATH_INVALID", 400)
	}
	if b.excluded(out.Path) {
		return out, media.Failure("FILE_PLATFORM_EXCLUDED", 404)
	}
	if err := library.NoLinks(out.Path); err != nil {
		return out, media.Failure("FILE_UNAVAILABLE", 404)
	}
	real, err := filepath.EvalSymlinks(out.Path)
	if err != nil {
		return out, media.Failure("FILE_UNAVAILABLE", 404)
	}
	if !library.Inside(out.Root.PhysicalRoot, real) {
		return out, media.Failure("FILE_PATH_INVALID", 400)
	}
	if b.excluded(real) {
		return out, media.Failure("FILE_PLATFORM_EXCLUDED", 404)
	}
	out.Path = real
	out.Info, err = os.Lstat(real)
	if err != nil {
		return out, media.Failure("FILE_UNAVAILABLE", 404)
	}
	return out, nil
}
func (b *Browser) excluded(path string) bool {
	for _, p := range b.Config.Platforms {
		if library.Inside(p.PhysicalRoot, path) {
			return true
		}
	}
	return false
}
func fileDTO(root, relative, name string, st os.FileInfo) (reading.Row, error) {
	if st.Size() > 9007199254740991 {
		return nil, media.Failure("FILE_SIZE_UNSUPPORTED", 422)
	}
	q := "?root=" + protocol.FormComponent(root) + "&path=" + protocol.FormComponent(relative)
	return reading.Row{"name": name, "relativePath": relative, "type": library.MediaKind(filepath.Ext(name)), "size": st.Size(), "url": "/api/v1/file-media" + q, "thumbnailUrl": "/api/v1/file-thumbnails" + q}, nil
}
func (b *Browser) Media(root, path string) (media.File, error) {
	l, err := b.Resolve(root, path)
	if err != nil {
		return media.File{}, err
	}
	kind := library.MediaKind(filepath.Ext(l.Path))
	if !l.Info.Mode().IsRegular() || kind == "" {
		return media.File{}, media.Failure("FILE_MEDIA_NOT_FOUND", 404)
	}
	return media.File{Path: l.Path, Root: l.Root.PhysicalRoot, Info: l.Info, Platform: "file:" + root, WorkID: root, MediaID: l.Relative, RelativeKey: protocol.Lower(l.Relative), Kind: kind}, nil
}

type Options struct {
	Page          float64
	Size          int
	Filter, Order string
}

func (o Options) valid(maxSize int, safe bool) bool {
	return !math.IsInf(o.Page, 0) && !math.IsNaN(o.Page) && math.Trunc(o.Page) == o.Page && o.Page >= 1 && (!safe || o.Page <= 9007199254740991) && o.Size >= 1 && o.Size <= maxSize && slices.Contains([]string{"all", "image", "video"}, o.Filter) && slices.Contains([]string{"asc", "desc"}, o.Order)
}
func hidden(name string) bool {
	return strings.HasPrefix(name, ".") || name == "$RECYCLE.BIN" || name == "System Volume Information"
}
func sortRows(rows []reading.Row, key, order string) {
	slices.SortStableFunc(rows, func(a, b reading.Row) int {
		c := reading.NaturalCompare(a[key].(string), b[key].(string))
		if order == "desc" {
			return -c
		}
		return c
	})
}
func slice(rows []reading.Row, o Options) []reading.Row {
	start := len(rows)
	if o.Page-1 <= float64(len(rows)/o.Size) {
		start = min(len(rows), int(o.Page-1)*o.Size)
	}
	return rows[start:min(len(rows), start+o.Size)]
}
func (b *Browser) List(root, relative string, o Options) (reading.Row, error) {
	if !o.valid(500, true) {
		return nil, media.Failure("FILE_QUERY_INVALID", 400)
	}
	current, err := b.Resolve(root, relative)
	if err != nil {
		return nil, err
	}
	if !current.Info.IsDir() {
		return nil, media.Failure("FILE_DIRECTORY_REQUIRED", 404)
	}
	entries, err := os.ReadDir(current.Path)
	if err != nil {
		return nil, media.Failure("FILE_DIRECTORY_UNREADABLE", 403)
	}
	dirs, files, diagnostics := []reading.Row{}, []reading.Row{}, []reading.Row{}
	for _, entry := range entries {
		if hidden(entry.Name()) {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 {
			diagnostics = append(diagnostics, reading.Row{"code": "FILE_LINK_SKIPPED"})
			continue
		}
		child := strings.TrimPrefix(current.Relative+"/"+entry.Name(), "/")
		found, err := b.Resolve(root, child)
		if err != nil {
			diagnostics = append(diagnostics, reading.Row{"code": "FILE_ENTRY_UNAVAILABLE"})
			continue
		}
		if found.Info.IsDir() {
			dirs = append(dirs, reading.Row{"name": entry.Name(), "type": "directory", "relativePath": child})
		} else if found.Info.Mode().IsRegular() && library.MediaKind(filepath.Ext(entry.Name())) != "" {
			dto, err := fileDTO(root, child, entry.Name(), found.Info)
			if err != nil {
				diagnostics = append(diagnostics, reading.Row{"code": "FILE_ENTRY_UNAVAILABLE"})
				continue
			}
			files = append(files, dto)
		}
	}
	sortRows(dirs, "name", o.Order)
	sortRows(files, "name", o.Order)
	visible := []reading.Row{}
	images, videos := 0, 0
	for _, f := range files {
		if f["type"] == "image" {
			images++
		} else {
			videos++
		}
		if o.Filter == "all" || f["type"] == o.Filter {
			visible = append(visible, f)
		}
	}
	all := append(slices.Clone(dirs), visible...)
	return reading.Row{"rootId": root, "path": current.Relative, "items": slice(all, o), "media": visible, "total": len(all), "totalDirectories": len(dirs), "totalImages": images, "totalVideos": videos, "page": o.Page, "pageSize": o.Size, "totalPages": max(1, (len(all)+o.Size-1)/o.Size), "diagnostics": diagnostics}, nil
}
