package indexing

import (
	"context"
	"database/sql"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"testing"
)

func TestIncrementalReuseRequiresCommittedCompatiblePhysicalWork(t *testing.T) {
	db, e := sql.Open("sqlite", ":memory:")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	_, e = db.Exec(`CREATE TABLE live_scan_works(platform_id TEXT,relative_path_key TEXT,fingerprint TEXT,adapter_version INTEGER,authority_at_ms INTEGER,authority_source_id TEXT);
	CREATE TABLE works(platform_id TEXT,relative_path_key TEXT,metadata_state TEXT,adapter_version INTEGER,relative_path TEXT,filesystem_files_state TEXT,filesystem_state TEXT);`)
	if e != nil {
		t.Fatal(e)
	}
	w := library.Entry{Key: "synthetic\\1", Relative: "Synthetic\\1", Name: "1", Author: "Synthetic"}
	ctx := context.Background()
	for _, c := range []struct {
		name, stamp, state, physical string
		adapter                      int
		want                         bool
	}{
		{"current", processedSignature("pixiv", "hash"), "valid", "complete", metadata.Versions["pixiv"], true},
		{"legacy-same-contract", "hash", "valid", "complete", metadata.Versions["pixiv"], true},
		{"future-contract", "go2:hash", "valid", "complete", metadata.Versions["pixiv"], false},
		{"changed-listing", "different", "valid", "complete", metadata.Versions["pixiv"], false},
		{"old-adapter", processedSignature("pixiv", "hash"), "valid", "complete", 0, false},
		{"incomplete", processedSignature("pixiv", "hash"), "valid", "incomplete", metadata.Versions["pixiv"], false},
		{"unreadable", processedSignature("pixiv", "hash"), "unreadable", "complete", metadata.Versions["pixiv"], false},
		{"malformed-is-physical", processedSignature("pixiv", "hash"), "malformed", "complete", metadata.Versions["pixiv"], true},
		{"missing-is-physical", processedSignature("pixiv", "hash"), "missing", "complete", metadata.Versions["pixiv"], true},
	} {
		t.Run(c.name, func(t *testing.T) {
			if _, e = db.Exec("DELETE FROM works;DELETE FROM live_scan_works"); e != nil {
				t.Fatal(e)
			}
			if _, e = db.Exec("INSERT INTO works VALUES (?,?,?,?,?,?,?)", "pixiv", w.Key, c.state, c.adapter, w.Relative, c.physical, "present"); e != nil {
				t.Fatal(e)
			}
			if _, e = db.Exec("INSERT INTO live_scan_works VALUES (?,?,?,?,?,?)", "pixiv", w.Key, c.stamp, c.adapter, 42, "900719925474099312345"); e != nil {
				t.Fatal(e)
			}
			p, ok, e := committedWork(ctx, db, "pixiv", w, "hash")
			if e != nil || ok != c.want {
				t.Fatal(ok, e)
			}
			if ok && (p.AuthorKey != "synthetic" || p.AuthorityID != "900719925474099312345" || !p.Reused || p.AuthorityTime != 42) {
				t.Fatal("identity/authority changed", p)
			}
		})
	}
	if _, e = db.Exec("DELETE FROM live_scan_works"); e != nil {
		t.Fatal(e)
	}
	if _, ok, e := committedWork(ctx, db, "pixiv", w, "hash"); e != nil || ok {
		t.Fatal("uncommitted listing qualified", ok, e)
	}
	if _, ok, e := committedWork(ctx, db, "X", w, "hash"); e != nil || ok {
		t.Fatal("cross-platform reuse", ok, e)
	}
}

func TestIncrementalScopeBoundaryValidation(t *testing.T) {
	for _, c := range []struct {
		mode, author string
		ids          []string
		want         bool
	}{
		{"", "", []string{"pixiv"}, true}, {"incremental", "Synthetic author", []string{"pixiv"}, true},
		{"incremental", "..", []string{"pixiv"}, false}, {"incremental", "a/b", []string{"pixiv"}, false},
		{"incremental", `a\b`, []string{"pixiv"}, false}, {"incremental", `C:escape`, []string{"pixiv"}, false},
		{"incremental", "author", []string{"pixiv", "X"}, false}, {"invalid", "", []string{"pixiv"}, false},
	} {
		p := Pipeline{Mode: c.mode, AuthorDirectoryName: c.author}
		if e := p.validateScope(c.ids); (e == nil) != c.want {
			t.Fatal(c, e)
		}
	}
}
