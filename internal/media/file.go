// Package media serves source files read-only and owns derived thumbnail jobs.
package media

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

type File struct {
	Path, Root, Platform, WorkID, MediaID, RelativeKey, Kind string
	Info                                                     os.FileInfo
}

func Failure(code string, status int) error { return &protocol.Error{Code: code, Status: status} }

// Relative uses the Windows path vocabulary used by the stored public contract.
func Relative(value string) (string, error) {
	if value == "" || strings.ContainsAny(value, "\x00:") || strings.HasPrefix(value, "/") || strings.HasPrefix(value, `\`) {
		return "", fmt.Errorf("invalid relative path")
	}
	parts := strings.FieldsFunc(value, func(r rune) bool { return r == '/' || r == '\\' })
	for _, p := range parts {
		if p == "." || p == ".." {
			return "", fmt.Errorf("relative traversal")
		}
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("empty relative path")
	}
	return strings.Join(parts, "/"), nil
}

func Resolve(config instance.Config, m reading.Row) (File, error) {
	if m == nil {
		return File{}, Failure("MEDIA_NOT_FOUND", 404)
	}
	f := File{Platform: m["platform_id"].(string), WorkID: fmt.Sprint(m["work_id"]), MediaID: fmt.Sprint(m["media_id"]), RelativeKey: m["relative_path_key"].(string), Kind: m["filesystem_media_type"].(string)}
	f.Root = config.Sources[f.Platform]
	work, err := Relative(m["work_relative_path"].(string))
	if err != nil {
		return f, Failure("MEDIA_UNAVAILABLE", 404)
	}
	rel, err := Relative(m["relative_path"].(string))
	if err != nil {
		return f, Failure("MEDIA_UNAVAILABLE", 404)
	}
	f.Path = filepath.Join(f.Root, filepath.FromSlash(work), filepath.FromSlash(rel))
	if !library.Inside(f.Root, f.Path) {
		return f, Failure("MEDIA_UNAVAILABLE", 404)
	}
	if err = library.NoLinks(f.Path); err != nil {
		return f, Failure("MEDIA_UNAVAILABLE", 404)
	}
	f.Info, err = os.Lstat(f.Path)
	if err != nil || !f.Info.Mode().IsRegular() {
		return f, Failure("MEDIA_UNAVAILABLE", 404)
	}
	return f, nil
}

type Service struct{ Cache *Cache }

func New(config instance.Config) (*Service, error) {
	cache, err := NewCache(config)
	if err != nil {
		return nil, err
	}
	return &Service{Cache: cache}, nil
}
func (s *Service) Close() error { return s.Cache.Close() }
func (s *Service) Thumbnail(ctx context.Context, f File) (File, string, error) {
	return s.Cache.Thumbnail(ctx, f)
}
