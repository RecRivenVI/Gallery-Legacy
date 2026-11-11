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

type tableRefresh struct {
	Platform, Scope, Method, Reason string
}

func (s *tableSnapshot) interested(ref, parent uint64, author string) bool {
	if _, known := s.paths[ref]; known {
		return true
	}
	_, known := s.directories[parent]
	return known && (author == "" || parent != s.root)
}

// Resolve creations before replaying files so a child's record can precede its
// parent's close record. The live record must still prove the observed parent.
func (v *ntfsVolume) addJournalDirectories(ctx context.Context, s *tableSnapshot, scope resolvedScope, start, end journalCursor) (map[string]TableRow, error) {
	pending := map[uint64]uint64{}
	if err := v.changes(ctx, start, end, func(change journalChange) error {
		if change.Attributes&usnDirectory != 0 && change.Reason&usnTopology == usnCreated {
			pending[change.Ref] = change.Parent
		}
		return nil
	}); err != nil {
		return nil, err
	}
	delta := map[string]TableRow{}
	var add func(uint64) error
	add = func(ref uint64) error {
		parentRef, pendingCreation := pending[ref]
		delete(pending, ref)
		if _, exists := s.directories[ref]; !pendingCreation || exists {
			return nil
		}
		if err := add(parentRef); err != nil {
			return err
		}
		parent, known := s.directories[parentRef]
		if !known {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		record, err := v.logicalRecord(ref)
		if err != nil {
			return errors.Join(errTopology, err)
		}
		var path string
		for _, name := range record.Names {
			if name.Namespace == 2 || name.Parent != parentRef {
				continue
			}
			candidate, err := tableRelative(parent, name.Name)
			if err != nil || path != "" && path != candidate {
				return errTopology
			}
			path = candidate
		}
		if scope.Author != "" && parentRef == s.root && path != "" && !strings.EqualFold(path, scope.Author) {
			return nil
		}
		if path == "" || !record.Directory || !record.Standard || record.Reparse {
			return errTopology
		}
		row := v.tableRow(ref, parentRef, path, record)
		if err := s.add(row); err != nil {
			return errors.Join(errTopology, err)
		}
		delta[strings.ToLower(path)] = row
		return nil
	}
	for ref := range pending {
		if err := add(ref); err != nil {
			return nil, err
		}
	}
	return delta, nil
}

func (v *ntfsVolume) replay(ctx context.Context, s *tableSnapshot, scope resolvedScope, start, end journalCursor) (map[string]TableRow, error) {
	delta, err := v.addJournalDirectories(ctx, s, scope, start, end)
	if err != nil {
		return nil, err
	}
	changes := map[uint64]journalChange{}
	directories := map[uint64]bool{}
	err = v.changes(ctx, start, end, func(change journalChange) error {
		interested := s.interested(change.Ref, change.Parent, scope.Author)
		if change.Attributes&usnDirectory != 0 {
			topology := change.Reason & usnTopology
			// The root is retained even in an author-only snapshot. A direct
			// child can become the selected author, so check it without opening
			// or traversing any other author directory.
			if !interested && scope.Author != "" && change.Parent == s.root && topology != 0 && topology != usnCreated {
				r, e := v.logicalRecord(change.Ref)
				if e != nil && !errors.Is(e, errRecordReplaced) {
					return e
				}
				for _, n := range r.Names {
					interested = interested || n.Parent == s.root && strings.EqualFold(n.Name, scope.Author)
				}
			}
			if interested && topology != 0 && topology != usnCreated {
				return errTopology
			}
			if interested {
				if topology == usnCreated {
					row, known := s.rows[strings.ToLower(s.directories[change.Ref])]
					if !known || row.Parent != change.Parent {
						return errTopology
					}
					directories[change.Parent] = true
				}
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
		actual, mtime, err := directoryAttributes(filepath.Join(scope.Root, path))
		if err != nil || actual != ref {
			return nil, errors.Join(errTopology, err)
		}
		key := strings.ToLower(path)
		row := s.rows[key]
		row.Mtime = mtime
		delta[key], s.rows[key] = row, row
	}
	return delta, nil
}

func RefreshTable(ctx context.Context, instance string, scopes []TableScope, incremental bool) (result error) {
	return refreshTable(ctx, instance, scopes, incremental, func(tableRefresh) {})
}

func refreshTable(ctx context.Context, instance string, scopes []TableScope, incremental bool, report func(tableRefresh)) (result error) {
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
		if err := refreshVolume(ctx, db, group, incremental, report); err != nil {
			return err
		}
	}
	return nil
}

func refreshVolume(ctx context.Context, db *sql.DB, requested []TableScope, incremental bool, report func(tableRefresh)) error {
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
		note := tableRefresh{Platform: scope.Platform, Scope: "platform", Method: "replay"}
		if scope.Author != "" {
			note.Scope = "author"
		}
		rebuild := func(reason string) {
			note.Method, note.Reason = "rebuild", reason
			report(note)
			baseline = append(baseline, scope)
		}
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
		switch {
		case !incremental:
			rebuild("full_scan")
		case err != nil:
			rebuild("checkpoint_missing")
		case old.serial != v.serial || old.root != scope.ref:
			rebuild("scope_identity_changed")
		case !end.follows(old.cursor):
			rebuild("journal_discontinuous")
		}
		if note.Method == "rebuild" {
			continue
		}
		if old.cursor.Next == end.Next && !fromPlatform {
			note.Method = "unchanged"
			report(note)
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
			reason := "journal_replay_failed"
			if errors.Is(err, errTopology) {
				reason = "directory_topology_changed"
			}
			rebuild(reason)
			continue
		}
		if fromPlatform {
			delta = nil
		}
		if err = saveSnapshot(ctx, db, scope, v.serial, end, s, delta); err != nil {
			return err
		}
		report(note)
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
