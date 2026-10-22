// Package inspection provides private read-only diagnostics, never Catalog writes.
package inspection

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

type Row = map[string]any
type issue struct{ Code, Path string }
type work struct {
	Platform, Author, Name, Relative, MetadataState string
	Files                                           []library.Entry
	Complete                                        bool
	Diagnostics                                     int
	Parsed                                          metadata.Result
}
type observer struct {
	Work   func(work) error
	Author func()
	Issue  func(string, string, string, Row)
}

func ordinal(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}
func entries(root, relative string) ([]os.DirEntry, error) {
	p := filepath.Join(root, relative)
	if err := library.NoLinks(p); err != nil {
		return nil, err
	}
	list, err := os.ReadDir(p)
	slices.SortFunc(list, func(a, b os.DirEntry) int { return ordinal(a.Name(), b.Name()) })
	return list, err
}
func (o observer) platform(ctx context.Context, c instance.Config, id, author string) error {
	root := c.Sources[id]
	authors, err := entries(root, "")
	if err != nil {
		o.Issue("filesystem.unreadable", id, "", nil)
		return nil
	}
	for _, a := range authors {
		if err = ctx.Err(); err != nil {
			return err
		}
		if author != "" && a.Name() != author {
			continue
		}
		rel := a.Name()
		if a.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 || !a.IsDir() {
			code := "unexpected_platform_file"
			if a.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 {
				code = "reparse_not_followed"
			}
			o.Issue("filesystem.ignored", id, rel, Row{"code": code})
			continue
		}
		o.Author()
		works, e := entries(root, rel)
		if e != nil {
			o.Issue("filesystem.unreadable", id, rel, nil)
			continue
		}
		for _, w := range works {
			if err = ctx.Err(); err != nil {
				return err
			}
			wr := filepath.Join(rel, w.Name())
			if w.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 || !w.IsDir() {
				code := "unexpected_author_file"
				if w.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 {
					code = "reparse_not_followed"
				}
				o.Issue("filesystem.ignored", id, strings.ReplaceAll(wr, "/", "\\"), Row{"code": code})
				continue
			}
			v := observe(ctx, root, id, a.Name(), w.Name())
			if err = o.Work(v); err != nil {
				return err
			}
		}
	}
	return nil
}
func observe(ctx context.Context, root, id, author, name string) work {
	w := work{Platform: id, Author: author, Name: name, Relative: author + "\\" + name, Complete: true, MetadataState: "missing"}
	base := filepath.Join(root, author, name)
	children, err := entries(base, "")
	if err != nil {
		w.Complete = false
		w.MetadataState = "unreadable"
		w.Diagnostics++
		return w
	}
	meta := filepath.Join(base, "metadata.json")
	before, e := os.Lstat(meta)
	if e == nil {
		w.MetadataState = "unreadable"
		if before.Mode().IsRegular() {
			bytes, _, e := library.ReadSource(root, meta, before.Size())
			if e == nil {
				w.MetadataState = "present"
				w.Parsed, _ = metadata.Parse(id, author, name, bytes)
			} else {
				w.Diagnostics++
			}
		} else {
			w.Diagnostics++
		}
	} else if !os.IsNotExist(e) {
		w.MetadataState = "unreadable"
		w.Diagnostics++
	}
	var walk func(string, []os.DirEntry)
	walk = func(relative string, list []os.DirEntry) {
		if ctx.Err() != nil {
			w.Complete = false
			return
		}
		for _, child := range list {
			if relative == "" && child.Name() == "metadata.json" {
				continue
			}
			rel := filepath.Join(relative, child.Name())
			full := filepath.Join(base, rel)
			st, e := os.Lstat(full)
			if e != nil {
				w.Complete = false
				w.Diagnostics++
				continue
			}
			if st.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
				w.Diagnostics++
				continue
			}
			if st.IsDir() {
				list, e := entries(base, rel)
				if e != nil {
					w.Complete = false
					w.Diagnostics++
					continue
				}
				walk(rel, list)
				continue
			}
			if !st.Mode().IsRegular() {
				w.Complete = false
				w.Diagnostics++
				continue
			}
			w.Files = append(w.Files, library.NativeEntry(id, rel, st))
		}
	}
	walk("", children)
	return w
}

var cover = regexp.MustCompile(`(?i)^\.?cover\.[^.]+$`)
var preview = regexp.MustCompile(`^[1-9]\.[^.]+$`)

func findings(w work, add func(string, Row)) {
	if !w.Complete {
		add("filesystem.incomplete", nil)
	}
	actual, hidden, unknown, covers, nocover := 0, 0, 0, 0, false
	extracted := false
	for _, e := range w.Parsed.Evidence {
		if e.Field == "media.extractedPreviews" {
			extracted = true
		}
	}
	for _, f := range w.Files {
		n := filepath.Base(f.Relative)
		ext := strings.ToLower(filepath.Ext(n))
		if library.MediaKind(ext) != "" && !strings.EqualFold(n, "metadata.json") {
			actual++
			if strings.HasPrefix(n, ".") || cover.MatchString(n) || extracted && preview.MatchString(n) {
				hidden++
			}
			if cover.MatchString(n) {
				covers++
			}
		} else if ext != ".vtt" && ext != ".json" && !strings.HasPrefix(n, ".") {
			unknown++
		}
		if strings.EqualFold(f.Relative, ".nocover") {
			nocover = true
		}
	}
	if actual == 0 {
		add("media.none", nil)
	} else if hidden == actual {
		add("media.all_hidden", nil)
	}
	if unknown > 0 {
		add("media.unknown_extension", Row{"count": unknown})
	}
	if covers > 1 {
		add("cover.multiple", Row{"count": covers})
	}
	if covers > 0 && nocover {
		add("cover.conflict", nil)
	}
	switch w.MetadataState {
	case "missing":
		add("metadata.missing", nil)
	case "present":
		if !w.Parsed.Valid {
			add("metadata.invalid", nil)
		} else if w.Parsed.Warnings > 0 || w.Parsed.InvalidFields > 0 {
			add("metadata.fields", Row{"warnings": w.Parsed.Warnings, "invalidFields": w.Parsed.InvalidFields})
		}
	default:
		add("metadata.unreadable", nil)
	}
}
