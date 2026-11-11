package physical

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

type MetadataFile struct {
	Platform string `json:"platform"`
	Relative string `json:"relative"`
	Offset   int64  `json:"offset"`
	Size     int64  `json:"size"`
	Mtime    int64  `json:"mtimeNs"`
}

type scopeDirectory struct{ platform, relative string }

// The resolver caches only directories proven below one of the requested
// roots. Names of other volume entries are not written, logged or cached.
type scopeResolver struct {
	known map[uint64]scopeDirectory
	read  func(uint64) (fileRecord, error)
}

func (s *scopeResolver) directory(ref uint64, visiting map[uint64]bool) (scopeDirectory, bool, error) {
	if d, ok := s.known[ref]; ok {
		return d, true, nil
	}
	if ref&referenceMask == 5 {
		return scopeDirectory{}, false, nil
	}
	if visiting[ref] {
		return scopeDirectory{}, false, errors.New("NTFS_PARENT_CYCLE")
	}
	visiting[ref] = true
	defer delete(visiting, ref)
	r, err := s.read(ref)
	if err != nil {
		return scopeDirectory{}, false, err
	}
	if !r.Directory || r.Reparse {
		return scopeDirectory{}, false, nil
	}
	for _, name := range r.Names {
		if name.Namespace == 2 || name.Parent == ref {
			continue
		}
		parent, found, err := s.directory(name.Parent, visiting)
		if err != nil {
			return scopeDirectory{}, false, err
		}
		if !found {
			continue
		}
		if strings.ContainsAny(name.Name, `\/:`+"\x00") || name.Name == "." || name.Name == ".." {
			return scopeDirectory{}, false, errors.New("NTFS_NAME_INVALID")
		}
		d := scopeDirectory{parent.platform, strings.TrimPrefix(parent.relative+`\`+name.Name, `\`)}
		if strings.Count(d.relative, `\`) < 1 {
			s.known[ref] = d
		}
		return d, true, nil
	}
	return scopeDirectory{}, false, nil
}

func collectVolume(ctx context.Context, roots map[string]string, accept func(MetadataFile) error) error {
	var volume *ntfsVolume
	resolver := scopeResolver{known: map[uint64]scopeDirectory{}}
	for id, path := range roots {
		if volume == nil {
			var err error
			volume, err = openVolume(path)
			if err != nil {
				return err
			}
			defer volume.close()
			resolver.read = volume.readRecord
		}
		ref, err := directoryReference(path)
		if err != nil {
			return fmt.Errorf("NTFS_SCOPE_OPEN: %w", err)
		}
		resolver.known[ref] = scopeDirectory{platform: id}
	}
	if volume == nil {
		return nil
	}
	names := map[string]bool{"metadata.json": true}
	return volume.fileReferences(ctx, names, func(ref uint64) error {
		r, err := volume.readRecord(ref)
		if err != nil {
			return err
		}
		if r.Directory || r.Reparse {
			return nil
		}
		for _, name := range r.Names {
			if name.Namespace == 2 || !names[strings.ToLower(name.Name)] {
				continue
			}
			d, found, err := resolver.directory(name.Parent, map[uint64]bool{})
			if err != nil {
				return err
			}
			if !found {
				continue
			}
			if strings.Count(d.relative, `\`) != 1 {
				continue
			}
			position, known := volume.position(ref, r)
			if !known {
				position = -1
			}
			if err = accept(MetadataFile{d.platform, d.relative + `\` + name.Name, position, r.Size, r.Mtime}); err != nil {
				return err
			}
		}
		return nil
	})
}

func Collect(ctx context.Context, roots map[string]string, accept func(MetadataFile) error) error {
	volumes := map[string]map[string]string{}
	for id, path := range roots {
		volume := strings.ToLower(filepath.VolumeName(path))
		if volumes[volume] == nil {
			volumes[volume] = map[string]string{}
		}
		volumes[volume][id] = path
	}
	for _, roots := range volumes {
		if err := collectVolume(ctx, roots, accept); err != nil {
			return err
		}
	}
	return nil
}
