package catalog

import (
	"context"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"testing"
)

func TestIncrementalProfileOnlyCompletionAndLedgerRollback(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	p := prepared(`{"id":"1","title":"Synthetic anchor","user":{"id":"700","name":"Synthetic profile"}}`)
	end := AuthorEnd{p.Platform, p.AuthorKey, "first", true}
	if _, e := w.BatchWithCompletions(ctx, []PreparedWork{p}, []AuthorEnd{end}, []PreparedWork{Authority(p)}); e != nil {
		t.Fatal(e)
	}
	before, _ := w.Revision(ctx)
	end.Fingerprint = "bookkeeping-only"
	if _, e := w.BatchWithCompletions(ctx, nil, []AuthorEnd{end}, []PreparedWork{Authority(p)}); e != nil {
		t.Fatal(e)
	}
	if after, _ := w.Revision(ctx); after != before || w.LastAdded != 0 || w.LastUpdated != 0 {
		t.Fatal("bookkeeping became content", before, after)
	}
	// A profile-only transaction may fail after extracting a cached anchor.
	r, _ := metadata.Parse(p.Platform, "700", "1", []byte(`{"id":"1","user":{"id":"700","name":"Synthetic changed"}}`))
	next := Fill(p.Platform, "700", "1", p.Work["relative_path"].(string), 1, "valid", nil, nil, r, "", p.Fingerprint, nil)
	w.failAfter = w.statements + 1
	if _, e := w.BatchWithCompletions(ctx, nil, []AuthorEnd{{p.Platform, p.AuthorKey, "changed", true}}, []PreparedWork{Authority(next)}); e == nil {
		t.Fatal("injected failure lost")
	}
	var stamp, name string
	w.DB.QueryRow("SELECT fingerprint FROM live_scan_authors").Scan(&stamp)
	w.DB.QueryRow("SELECT display_name FROM authors").Scan(&name)
	if stamp != "bookkeeping-only" || name != "Synthetic profile" {
		t.Fatal("rolled back profile/ledger escaped", stamp, name)
	}
	w.failAfter = 0
	next.Qualified = false
	if _, e := w.BatchWithCompletions(ctx, nil, []AuthorEnd{{p.Platform, p.AuthorKey, "", true}}, []PreparedWork{Authority(next)}); e != nil {
		t.Fatal(e)
	}
	var count int
	w.DB.QueryRow("SELECT count(*) FROM live_scan_authors").Scan(&count)
	if count != 0 {
		t.Fatal("unqualified author retained a reusable ledger")
	}
	w.DB.QueryRow("SELECT count(*) FROM live_scan_works").Scan(&count)
	if count != 0 {
		t.Fatal("unreadable cached anchor remained qualified")
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
	empty := Fill("pixiv", "Synthetic empty", "", "Synthetic empty", 1, "missing", nil, nil, metadata.New(), "", "", nil)
	if e := w.EmptyAuthor(ctx, empty.Author); e != nil {
		t.Fatal(e)
	}
	revision, _ := w.Revision(ctx)
	var platformRevision int64
	if e := w.DB.QueryRow("SELECT last_revision FROM live_platform_stats WHERE platform_id='pixiv'").Scan(&platformRevision); e != nil || platformRevision != revision {
		t.Fatal("empty author revision missing", e, platformRevision, revision)
	}
	if e := w.EmptyAuthor(ctx, empty.Author); e != nil {
		t.Fatal(e)
	}
	if repeated, _ := w.Revision(ctx); repeated != revision {
		t.Fatal("existing empty author became new content")
	}
}
