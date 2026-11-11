package physical

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type TableRow struct {
	Relative              string
	Ref, Parent           uint64
	Directory             bool
	Size, Mtime, Position int64
}

type TableScope struct {
	Platform, Root, Author string
}

type tableSnapshot struct {
	root        uint64
	rows        map[string]TableRow
	directories map[uint64]string
	paths       map[uint64][]string
}

func newSnapshot(root uint64) *tableSnapshot {
	return &tableSnapshot{root, map[string]TableRow{}, map[uint64]string{}, map[uint64][]string{}}
}

func (s *tableSnapshot) add(row TableRow) error {
	key := strings.ToLower(row.Relative)
	if current, exists := s.rows[key]; exists {
		if current == row {
			return nil
		}
		return errors.New("NTFS_SCOPE_DUPLICATE_PATH")
	}
	s.rows[key] = row
	s.paths[row.Ref] = append(s.paths[row.Ref], key)
	if row.Directory {
		s.directories[row.Ref] = row.Relative
	}
	return nil
}

func tableRelative(parent, name string) (string, error) {
	if strings.ContainsAny(name, `\/:`+"\x00") || name == "" || name == "." || name == ".." {
		return "", errors.New("NTFS_SCOPE_NAME_INVALID")
	}
	if parent == "." {
		return name, nil
	}
	return parent + `\` + name, nil
}

type tableChild struct {
	ref  uint64
	name string
}

func (v *ntfsVolume) snapshots(ctx context.Context, scopes []resolvedScope) ([]*tableSnapshot, error) {
	records := map[uint64]fileRecord{}
	extensions := map[uint64]fileRecord{}
	if err := v.records(ctx, func(ref uint64, r fileRecord) error {
		r.AttributeList, r.AttributeRuns = nil, nil
		if r.Base != 0 {
			all := extensions[r.Base]
			all.include(r)
			extensions[r.Base] = all
		} else {
			records[ref] = r
		}
		return nil
	}); err != nil {
		return nil, err
	}
	for ref, ext := range extensions {
		if base, ok := records[ref]; ok {
			base.include(ext)
			records[ref] = base
		}
	}
	children := map[uint64][]tableChild{}
	for ref, record := range records {
		for _, name := range record.Names {
			if name.Namespace != 2 && name.Parent != ref {
				children[name.Parent] = append(children[name.Parent], tableChild{ref, name.Name})
			}
		}
	}
	result := make([]*tableSnapshot, len(scopes))
	for i, scope := range scopes {
		s := newSnapshot(scope.ref)
		result[i] = s
		root, ok := records[scope.ref]
		if !ok || !root.Directory || root.Reparse || !root.Standard {
			return nil, errors.New("NTFS_SCOPE_MISSING_FROM_TABLE")
		}
		if err := s.add(TableRow{Relative: ".", Ref: scope.ref, Directory: true, Mtime: root.Mtime, Position: -1}); err != nil {
			return nil, err
		}
		if scope.Author == "" {
			if err := v.addTableTree(ctx, s, scope.ref, ".", records, children); err != nil {
				return nil, err
			}
		} else {
			for _, child := range children[scope.ref] {
				r := records[child.ref]
				if strings.EqualFold(child.name, scope.Author) {
					if !r.Directory || r.Reparse || !r.Standard {
						return nil, errors.New("NTFS_AUTHOR_SCOPE_INVALID")
					}
					if err := s.add(TableRow{Relative: child.name, Ref: child.ref, Parent: scope.ref, Directory: true, Mtime: r.Mtime, Position: -1}); err != nil {
						return nil, err
					}
					if err := v.addTableTree(ctx, s, child.ref, child.name, records, children); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	return result, nil
}

func (v *ntfsVolume) addTableTree(ctx context.Context, s *tableSnapshot, root uint64, relative string, records map[uint64]fileRecord, children map[uint64][]tableChild) error {
	type folder struct {
		ref  uint64
		path string
	}
	pending := []folder{{root, relative}}
	for len(pending) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		parent := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		for _, child := range children[parent.ref] {
			r := records[child.ref]
			path, err := tableRelative(parent.path, child.name)
			if err != nil {
				return err
			}
			if r.Directory {
				if previous, exists := s.directories[child.ref]; exists && previous != path {
					return errors.New("NTFS_DIRECTORY_MULTIPLE_PATHS")
				} else if exists {
					continue
				}
				pending = append(pending, folder{child.ref, path})
			}
			if err = s.add(v.tableRow(child.ref, parent.ref, path, r)); err != nil {
				return err
			}
			if r.Reparse || !r.Standard {
				return errors.New("NTFS_SCOPE_REPARSE_OR_INVALID")
			}
		}
	}
	return nil
}

func (v *ntfsVolume) tableRow(ref, parent uint64, path string, r fileRecord) TableRow {
	row := TableRow{Relative: path, Ref: ref, Parent: parent, Directory: r.Directory, Size: r.Size, Mtime: r.Mtime, Position: -1}
	if r.Directory {
		row.Size = 0
	} else if strings.EqualFold(filepath.Base(path), "metadata.json") || library.MediaKind(filepath.Ext(path)) != "" {
		if position, known := v.position(ref, r); known {
			row.Position = position
		}
	}
	return row
}

type resolvedScope struct {
	TableScope
	ref uint64
}

func resolveScopes(scopes []TableScope) ([]resolvedScope, error) {
	resolved := make([]resolvedScope, 0, len(scopes))
	for _, scope := range scopes {
		if err := library.NoLinks(scope.Root); err != nil {
			return nil, fmt.Errorf("NTFS_SCOPE_INVALID: %w", err)
		}
		ref, err := directoryReference(scope.Root)
		if err != nil {
			return nil, fmt.Errorf("NTFS_SCOPE_OPEN: %w", err)
		}
		resolved = append(resolved, resolvedScope{scope, ref})
	}
	return resolved, nil
}
