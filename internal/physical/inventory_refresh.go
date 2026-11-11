package physical

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"time"
)

var errTopology = errors.New("NTFS_SCOPE_TOPOLOGY_CHANGED")

func (s *tableSnapshot) interested(ref, parent uint64, author string) bool {
	if _, known := s.paths[ref]; known {
		return true
	}
	_, known := s.directories[parent]
	return known && (author == "" || parent != s.root)
}

func (v *ntfsVolume) replay(ctx context.Context, s *tableSnapshot, scope resolvedScope, start, end journalCursor) (map[string]TableRow, error) {
	changes := map[uint64]journalChange{}
	directories := map[uint64]bool{}
	err := v.changes(ctx, start, end, func(change journalChange) error {
		interested := s.interested(change.Ref, change.Parent, scope.Author)
		if change.Attributes&usnDirectory != 0 {
			// The root is retained even in an author-only snapshot. A direct
			// child can become the selected author, so check it without opening
			// or traversing any other author directory.
			if !interested && scope.Author != "" && change.Parent == s.root && change.Reason&usnTopology != 0 {
				r, e := v.logicalRecord(change.Ref)
				if e != nil && !errors.Is(e, errRecordReplaced) {
					return e
				}
				for _, n := range r.Names {
					interested = interested || n.Parent == s.root && strings.EqualFold(n.Name, scope.Author)
				}
			}
			if interested && change.Reason&usnTopology != 0 {
				return errTopology
			}
			if interested {
				directories[change.Ref] = true
			}
		} else if interested || change.Reason&usnHardLink != 0 {
			change.Reason |= changes[change.Ref].Reason
			changes[change.Ref] = change
			directories[change.Parent] = true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	delta := map[string]TableRow{}
	for ref := range changes {
		for _, key := range s.paths[ref] {
			directories[s.rows[key].Parent] = true
			delete(s.rows, key)
			delta[key] = TableRow{}
		}
		delete(s.paths, ref)
	}
	for ref, change := range changes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		r, err := v.logicalRecord(ref)
		if err != nil && (!errors.Is(err, errRecordReplaced) || change.Reason&usnDeleted == 0) {
			return nil, err
		}
		if err != nil {
			continue
		}
		for _, name := range r.Names {
			parent, ok := s.directories[name.Parent]
			if !ok || name.Namespace == 2 || scope.Author != "" && name.Parent == s.root {
				continue
			}
			if r.Directory || r.Reparse || !r.Standard {
				return nil, errors.New("NTFS_SCOPE_REPARSE_OR_INVALID")
			}
			path, err := tableRelative(parent, name.Name)
			if err != nil {
				return nil, err
			}
			row := v.tableRow(ref, name.Parent, path, r)
			if err = s.add(row); err != nil {
				return nil, err
			}
			delta[strings.ToLower(path)] = row
			directories[name.Parent] = true
		}
	}
	for ref := range directories {
		path, ok := s.directories[ref]
		if !ok {
			continue
		}
		r, err := v.logicalRecord(ref)
		if err != nil {
			return nil, err
		}
		if !r.Directory || !r.Standard || r.Reparse {
			return nil, errTopology
		}
		key := strings.ToLower(path)
		row := s.rows[key]
		row.Mtime = r.Mtime
		delta[key], s.rows[key] = row, row
	}
	return delta, nil
}

func RefreshTable(ctx context.Context, instance string, scopes []TableScope, incremental bool) (result error) {
	db, err := tableStore(ctx, instance)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, db.Close()) }()
	volumes := map[string][]TableScope{}
	for _, scope := range scopes {
		key := strings.ToLower(filepath.VolumeName(scope.Root))
		volumes[key] = append(volumes[key], scope)
	}
	for _, group := range volumes {
		if err := refreshVolume(ctx, db, group, incremental); err != nil {
			return err
		}
	}
	return nil
}

func refreshVolume(ctx context.Context, db *sql.DB, requested []TableScope, incremental bool) error {
	started := time.Now()
	v, err := openVolume(requested[0].Root)
	if err != nil {
		return err
	}
	defer v.close()
	scopes, err := resolveScopes(requested)
	if err != nil {
		return err
	}
	end, err := v.journal()
	if err != nil {
		return err
	}
	var baseline []resolvedScope
	for _, scope := range scopes {
		old, err := checkpointFor(ctx, db, scope)
		fromPlatform := false
		if incremental && scope.Author != "" && errors.Is(err, sql.ErrNoRows) {
			platform := scope
			platform.Author = ""
			old, err = checkpointFor(ctx, db, platform)
			fromPlatform = err == nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if !incremental || err != nil || old.serial != v.serial || old.root != scope.ref || !end.follows(old.cursor) {
			baseline = append(baseline, scope)
			continue
		}
		if old.cursor.Next == end.Next && !fromPlatform {
			continue
		}
		s, err := loadSnapshot(ctx, db, scope, fromPlatform)
		if err != nil {
			return err
		}
		delta, err := v.replay(ctx, s, scope, old.cursor, end)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			baseline = append(baseline, scope)
			continue
		}
		if fromPlatform {
			delta = nil
		}
		if err = saveSnapshot(ctx, db, scope, v.serial, end, s, delta); err != nil {
			return err
		}
	}
	if len(baseline) > 0 {
		if err = v.refreshBaseline(ctx, db, baseline); err != nil {
			return err
		}
	}
	slog.InfoContext(ctx, "文件表清单已更新", "scopes", len(scopes), "fullScopes", len(baseline), "elapsedMs", time.Since(started).Milliseconds())
	return nil
}

func (v *ntfsVolume) refreshBaseline(ctx context.Context, db *sql.DB, scopes []resolvedScope) error {
	for attempt := 0; attempt < 2; attempt++ {
		start, err := v.journal()
		if err != nil {
			return err
		}
		snapshots, err := v.snapshots(ctx, scopes)
		if err != nil {
			return err
		}
		end, err := v.journal()
		if err != nil {
			return err
		}
		if !end.follows(start) {
			continue
		}
		for i, scope := range scopes {
			if _, err = v.replay(ctx, snapshots[i], scope, start, end); err != nil {
				break
			}
			ref, err := directoryReference(scope.Root)
			if err != nil || ref != scope.ref {
				return fmt.Errorf("NTFS_SCOPE_CHANGED")
			}
		}
		if errors.Is(err, errTopology) {
			continue
		}
		if err != nil {
			return err
		}
		for i, scope := range scopes {
			if err := saveSnapshot(ctx, db, scope, v.serial, end, snapshots[i], nil); err != nil {
				return err
			}
		}
		return nil
	}
	return errors.New("NTFS_SCOPE_CHANGED_DURING_BASELINE")
}
