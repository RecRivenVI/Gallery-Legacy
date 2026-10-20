package catalog

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testWriter(t testing.TB) *Writer {
	t.Helper()
	seed := os.Getenv("GALLERY_GO_EMPTY_DB")
	if seed == "" {
		t.Fatal("synthetic GALLERY_GO_EMPTY_DB required")
	}
	b, e := os.ReadFile(seed)
	if e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(t.TempDir(), "catalog.sqlite")
	if e = os.WriteFile(file, b, 0600); e != nil {
		t.Fatal(e)
	}
	w, e := Open(file)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { w.Close() })
	return w
}

func TestWriterStoragePolicyKeepsFullAndCoalescedCheckpoint(t *testing.T) {
	w := testWriter(t)
	var mode string
	var synchronous, foreignKeys, cache, checkpoint int
	for _, pair := range []struct {
		query  string
		output any
	}{{"PRAGMA journal_mode", &mode}, {"PRAGMA synchronous", &synchronous}, {"PRAGMA foreign_keys", &foreignKeys}, {"PRAGMA cache_size", &cache}, {"PRAGMA wal_autocheckpoint", &checkpoint}} {
		if e := w.DB.QueryRow(pair.query).Scan(pair.output); e != nil {
			t.Fatal(e)
		}
	}
	if mode != "wal" || synchronous != 2 || foreignKeys != 1 || cache != -32768 || checkpoint != automaticCheckpointPages {
		t.Fatal("storage/durability policy drift", mode, synchronous, foreignKeys, cache, checkpoint)
	}
}

func TestWriterStatementsSurviveCommitAndRollback(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	p := prepared(`{"id":"1","title":"合成缓存","tags":["synthetic"]}`)
	if _, e := w.Batch(ctx, []PreparedWork{p}); e != nil {
		t.Fatal(e)
	}
	if len(w.prepared) == 0 || len(w.prepared) > 128 {
		t.Fatal("statement cache absent/unbounded")
	}
	var parent *sql.Stmt
	const query = "SELECT revision+1 FROM live_meta WHERE singleton=1"
	parent = w.prepared[query]
	if parent == nil {
		t.Fatal("query not retained")
	}
	if _, e := w.Batch(ctx, []PreparedWork{p}); e != nil {
		t.Fatal(e)
	}
	if w.prepared[query] != parent || w.Metrics.StatementCacheHits.Load() == 0 {
		t.Fatal("not reused across transactions")
	}
	before, _ := w.Revision(ctx)
	w.failAfter = w.statements + 1
	if _, e := w.Batch(ctx, []PreparedWork{p}); e == nil {
		t.Fatal("injected failure lost")
	}
	w.failAfter = 0
	if after, _ := w.Revision(ctx); after != before {
		t.Fatal("rollback changed revision")
	}
	if _, e := w.Batch(ctx, []PreparedWork{p}); e != nil {
		t.Fatal("cache unusable after rollback", e)
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
}

func TestAuthorCompletionJoinsWorkCommitAndRollback(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	p := prepared(`{"id":"1","title":"合成作品","user":{"id":"700","name":"Synthetic profile"}}`)
	end := AuthorEnd{p.Platform, p.AuthorKey, "author-signature", true}
	before, _ := w.Revision(ctx)
	// Fault after all work statements, at the first author/profile statement.
	probe := testWriter(t)
	if _, e := probe.Batch(ctx, []PreparedWork{p}); e != nil {
		t.Fatal(e)
	}
	w.failAfter = probe.statements + 1
	if _, e := w.BatchWithAuthors(ctx, []PreparedWork{p}, []AuthorEnd{end}); e == nil {
		t.Fatal("author failure lost")
	}
	var works, profiles, ledger int
	w.DB.QueryRow("SELECT count(*) FROM works").Scan(&works)
	w.DB.QueryRow("SELECT count(*) FROM author_profiles").Scan(&profiles)
	w.DB.QueryRow("SELECT count(*) FROM live_scan_authors").Scan(&ledger)
	if revision, _ := w.Revision(ctx); revision != before || works != 0 || profiles != 0 || ledger != 0 || len(w.candidates) != 0 {
		t.Fatal("failed completion leaked work/profile/ledger", works, profiles, ledger, revision)
	}
	w.failAfter = 0
	if _, e := w.BatchWithAuthors(ctx, []PreparedWork{p}, []AuthorEnd{end}); e != nil {
		t.Fatal(e)
	}
	if w.Metrics.Transactions.Load() != 1 {
		t.Fatal("completion used a separate FULL transaction")
	}
	w.DB.QueryRow("SELECT count(*) FROM author_profiles").Scan(&profiles)
	w.DB.QueryRow("SELECT count(*) FROM live_scan_authors WHERE fingerprint='author-signature'").Scan(&ledger)
	if profiles != 1 || ledger != 1 || len(w.candidates) != 0 {
		t.Fatal("profile/ledger completion incomplete", profiles, ledger)
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
}

func TestAuthorCompletionFailureRetainsCommittedCandidateForRetry(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	p := prepared(`{"id":"1","title":"Synthetic profile retry"}`)
	if _, e := w.Batch(ctx, []PreparedWork{p}); e != nil {
		t.Fatal(e)
	}
	w.failAfter = w.statements + 1
	if e := w.EndAuthor(ctx, p.Platform, p.AuthorKey, "author-signature", true); e == nil {
		t.Fatal("failure lost")
	}
	if len(w.candidates) != 1 {
		t.Fatal("committed authority candidate lost on rollback")
	}
	w.failAfter = 0
	if e := w.EndAuthor(ctx, p.Platform, p.AuthorKey, "author-signature", true); e != nil {
		t.Fatal(e)
	}
	var count int
	w.DB.QueryRow("SELECT count(*) FROM live_scan_authors").Scan(&count)
	if count != 1 || len(w.candidates) != 0 {
		t.Fatal("retry failed")
	}
	if _, e := w.BatchWithAuthors(ctx, nil, make([]AuthorEnd, 65)); e == nil {
		t.Fatal("unbounded completion batch")
	}
}

func Test128WorkBatchRollbackAndCommitGroups(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	works := benchmarkWorks(128)
	end := AuthorEnd{works[0].Platform, works[0].AuthorKey, "synthetic-author-signature", true}
	w.failAfter = 40
	if _, e := w.BatchWithAuthors(ctx, works, []AuthorEnd{end}); e == nil {
		t.Fatal("failure injection lost")
	}
	var count int
	if e := w.DB.QueryRow("SELECT count(*) FROM works").Scan(&count); e != nil || count != 0 {
		t.Fatal("partial batch escaped rollback", e, count)
	}
	if w.Metrics.Transactions.Load() != 0 || w.Metrics.WorkCommits.Count.Load() != 0 {
		t.Fatal("failed batch counted as confirmed")
	}
	w.failAfter = 0
	if _, e := w.BatchWithAuthors(ctx, works, []AuthorEnd{end}); e != nil {
		t.Fatal(e)
	}
	if e := w.DB.QueryRow("SELECT count(*) FROM works").Scan(&count); e != nil || count != 128 {
		t.Fatal("batch facts lost", e, count)
	}
	if w.Metrics.WorkCommits.Count.Load() != 1 || w.Metrics.AuthorCommits.Count.Load() != 0 {
		t.Fatal("joined commit misclassified")
	}
	if _, e := w.Batch(ctx, works[:1]); e != nil {
		t.Fatal(e)
	}
	if e := w.EndAuthor(ctx, end.Platform, end.Key, end.Fingerprint, true); e != nil {
		t.Fatal(e)
	}
	if w.Metrics.WorkCommits.Count.Load() != 2 || w.Metrics.AuthorCommits.Count.Load() != 1 {
		t.Fatal("author-only transaction misclassified")
	}
	if e := w.Remove(ctx, 1); e != nil {
		t.Fatal(e)
	}
	if w.Metrics.MaintenanceCommits.Count.Load() != 1 {
		t.Fatal("maintenance commit misclassified")
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
	if w.Metrics.WorkCommits.Nanos.Load()+w.Metrics.AuthorCommits.Nanos.Load()+w.Metrics.MaintenanceCommits.Nanos.Load() != w.Metrics.Commit.Load() {
		t.Fatal("commit category times do not reconcile")
	}
}

func TestSingleRowStatementsAreReusedAndErrorsRetainScanContract(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	tx, e := w.DB.BeginTx(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	tr := transaction{ctx: ctx, tx: tx, stmt: map[string]*sql.Stmt{}, owner: w}
	defer tr.close()
	for i := 0; i < 20; i++ {
		var n int
		if e = tr.get("SELECT revision FROM live_meta WHERE singleton=1").Scan(&n); e != nil {
			t.Fatal(e)
		}
	}
	if len(tr.stmt) != 1 {
		t.Fatal("query recompiled", len(tr.stmt))
	}
	var n int
	if e = tr.get("SELECT * FROM nonexistent_synthetic_table").Scan(&n); e == nil {
		t.Fatal("prepare error lost")
	}
}

func TestWriterRelationResolutionUsesCompleteTargetIndex(t *testing.T) {
	w := testWriter(t)
	query := "UPDATE social_relations SET target_work_id=(SELECT CASE WHEN count(*)=1 THEN min(work_id) END FROM works WHERE platform_id=? AND source_work_id=?) WHERE target_platform_id=? AND target_source_work_id=?"
	rows, e := w.DB.Query("EXPLAIN QUERY PLAN "+query, "X", "same", "X", "same")
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if e = rows.Scan(&id, &parent, &unused, &detail); e != nil {
			t.Fatal(e)
		}
		if strings.Contains(detail, "SCAN social_relations") {
			t.Fatal("relation resolution scans full table", detail)
		}
		if strings.Contains(detail, "live_idx_relation_target_all") {
			found = true
		}
	}
	if e = rows.Err(); e != nil || !found {
		t.Fatal("complete target index missing", e)
	}
}
func prepared(raw string) PreparedWork {
	r, m := metadata.Parse("pixiv", "700", "2026-01-01_00-00-00_test", []byte(raw))
	shape := ""
	if m != nil {
		shape = metadata.Shape("pixiv", m, nil, nil, 1)
	}
	p := Fill("pixiv", "700", "2026-01-01_00-00-00_test", `700\2026-01-01_00-00-00_test`, 1767225600000000000, "valid", 1767225600000000000, int64(len(raw)), r, shape, "fingerprint", []File{{"1.png", "1.png", "1.png", ".png", "image", 12, 1767225600000000000}})
	return p
}
func TestAtomicCatalogSearchCountsLedger(t *testing.T) {
	ctx := context.Background()
	w := testWriter(t)
	p := prepared(`{"id":"same","title":"中文 A","tags":["old"]}`)
	if _, e := w.Batch(ctx, []PreparedWork{p}); e != nil {
		t.Fatal(e)
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
	before, _ := w.Revision(ctx)
	w.failAfter = w.statements + 20
	p.Work["title"] = "must not appear"
	if _, e := w.Batch(ctx, []PreparedWork{p}); e == nil {
		t.Fatal("failure injection ignored")
	}
	after, _ := w.Revision(ctx)
	if before != after {
		t.Fatal("revision changed on rollback")
	}
	var title string
	w.DB.QueryRow("SELECT title FROM works").Scan(&title)
	if title != "中文 A" {
		t.Fatal("work changed on rollback")
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
}
func TestUpsertPreservesPhysicalIDsAndUpdatesShapeTags(t *testing.T) {
	ctx := context.Background()
	w := testWriter(t)
	p := prepared(`{"id":"same","title":"old","tags":["old"]}`)
	if _, e := w.Batch(ctx, []PreparedWork{p}); e != nil {
		t.Fatal(e)
	}
	var id, media, shape int64
	w.DB.QueryRow("SELECT work_id,metadata_shape_id FROM works").Scan(&id, &shape)
	w.DB.QueryRow("SELECT media_id FROM media").Scan(&media)
	p = prepared(`{"id":"same","title":"new","tags":["new"],"extra":true}`)
	p.Media[0]["source_media_id"] = "updated-enrichment"
	if _, e := w.Batch(ctx, []PreparedWork{p}); e != nil {
		t.Fatal(e)
	}
	var next, nextMedia, nextShape int64
	w.DB.QueryRow("SELECT work_id,metadata_shape_id FROM works").Scan(&next, &nextShape)
	w.DB.QueryRow("SELECT media_id FROM media").Scan(&nextMedia)
	if id != next || media != nextMedia || shape == nextShape {
		t.Fatal("identity or shape update wrong")
	}
	var n int
	w.DB.QueryRow("SELECT work_count FROM live_tags WHERE display_value='old'").Scan(&n)
	if n != 0 {
		t.Fatal("removed tag stale")
	}
	if e := w.EndAuthor(ctx, p.Platform, p.AuthorKey, "author-fingerprint", true); e != nil {
		t.Fatal(e)
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
	if e := w.Remove(ctx, id); e != nil {
		t.Fatal(e)
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
}
func TestIncompleteRejectedAndSourceCollisionRetained(t *testing.T) {
	ctx := context.Background()
	w := testWriter(t)
	p := prepared(`{"id":"collision","title":"first"}`)
	q := prepared(`{"id":"collision","title":"second"}`)
	q.Key = `700\another`
	q.Work["relative_path_key"] = q.Key
	q.Work["relative_path"] = q.Key
	if _, e := w.Batch(ctx, []PreparedWork{p, q}); e != nil {
		t.Fatal(e)
	}
	var n int
	w.DB.QueryRow("SELECT count(*) FROM works WHERE source_work_id='collision'").Scan(&n)
	if n != 2 {
		t.Fatal("collision removed physical work")
	}
	p.Work["filesystem_files_state"] = "incomplete"
	rev, _ := w.Revision(ctx)
	if _, e := w.Batch(ctx, []PreparedWork{p}); e == nil {
		t.Fatal("incomplete accepted")
	}
	next, _ := w.Revision(ctx)
	if rev != next {
		t.Fatal("incomplete committed")
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
}
func TestOpenNeverCreatesMissingDatabase(t *testing.T) {
	file := filepath.Join(t.TempDir(), "missing.sqlite")
	if w, e := Open(file); e == nil {
		w.Close()
		t.Fatal("missing database opened")
	}
	if _, e := os.Stat(file); !os.IsNotExist(e) {
		t.Fatal("missing database created")
	}
}
func TestMetadataCannotEraseActualMedia(t *testing.T) {
	files := []File{{Relative: "1.png", Key: "1.png", Name: "1.png", Kind: "image", Extension: ".png", Size: 10, Mtime: 1767225600000000000}}
	r := metadata.New()
	r.Declarations = []metadata.Declaration{{Kind: "video", References: []metadata.Reference{{Kind: "file_name", Value: "1.png"}}}, {Kind: "image", References: []metadata.Reference{{Kind: "file_name", Value: "missing.png"}}}}
	p := Fill("pixiv", "700", "work", `700\work`, 1767225600000000000, "valid", nil, nil, r, "", "sig", files)
	if len(p.Media) != 1 || p.Declarations[0]["match_state"] != "type_conflict" || p.Declarations[1]["match_state"] != "unmatched" {
		t.Fatal("declaration changed actual media")
	}
	r.Declarations = append(r.Declarations, metadata.Declaration{Kind: "image", References: []metadata.Reference{{Kind: "file_name", Value: "1.png"}}})
	p = Fill("pixiv", "700", "work", `700\work`, 1767225600000000000, "valid", nil, nil, r, "", "sig", files)
	if len(p.Media) != 1 || p.Declarations[0]["match_state"] != "ambiguous" || p.Declarations[2]["match_state"] != "ambiguous" {
		t.Fatal("ambiguity erased actual media")
	}
}
func TestSearchNormalization(t *testing.T) {
	if Normalize("<b>Ａ\u200b</b> &amp; &#x4e2d; &nbsp; ΟΣ İ") != "a & 中 &nbsp; ος i\u0307" {
		t.Fatal("Search v5 normalization mismatch")
	}
}

func TestNormalizationFastPathsMatchOriginalTransformation(t *testing.T) {
	pieces := []string{"普通文字", "ABC ΟΣ İ", "ＡＢＣ", "\u200b\u200e\u2060\ufeff", "<b>caption</b>", "<unclosed", "&amp; &QUOT; &apos; &nbsp; &#39;", "&#x4e2d; &#99999999; &#x110000;", "&amp;#x4e2d;", "\r\n\t\u3000", "😀", strings.Repeat("合成 abstract ", 512)}
	for _, a := range pieces {
		for _, b := range pieces {
			input := a + " " + b
			want := norm.NFKC.String(input)
			want = invisible.ReplaceAllString(want, "")
			want = markup.ReplaceAllString(want, " ")
			want = namedEntity.ReplaceAllStringFunc(want, decodeNamedEntity)
			want = numericEntity.ReplaceAllStringFunc(want, decodeNumericEntity)
			want = strings.Join(strings.Fields(cases.Lower(language.Und).String(want)), " ")
			if got := Normalize(input); got != want {
				t.Fatal("normalization semantics changed", a, b, got, want)
			}
		}
	}
}

func TestBatchDeduplicatesSharedAuthorTagAndReportsCommittedChanges(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	p := prepared(`{"id":"collision","title":"one","tags":["shared"]}`)
	q := prepared(`{"id":"collision","title":"two","tags":["shared"]}`)
	q.Key = `700\another`
	q.Work["relative_path_key"] = q.Key
	q.Work["relative_path"] = q.Key
	if _, e := w.Batch(ctx, []PreparedWork{p, q}); e != nil {
		t.Fatal(e)
	}
	if w.LastAdded != 2 || w.LastUpdated != 0 {
		t.Fatal("committed change counts incorrect")
	}
	var authorWorks, tagWorks int64
	if e := w.DB.QueryRow("SELECT work_count FROM live_authors").Scan(&authorWorks); e != nil {
		t.Fatal(e)
	}
	if e := w.DB.QueryRow("SELECT work_count FROM live_tags WHERE display_value='shared'").Scan(&tagWorks); e != nil {
		t.Fatal(e)
	}
	if authorWorks != 2 || tagWorks != 2 {
		t.Fatal("shared facts refreshed before batch completion")
	}
	if _, e := w.Batch(ctx, []PreparedWork{p, q}); e != nil {
		t.Fatal(e)
	}
	if w.LastAdded != 0 || w.LastUpdated != 2 {
		t.Fatal("upsert change counts incorrect")
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
}

func TestTransactionIDsPersistExactHighWaterAndRollbackDoesNotLeak(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	p := prepared(`{"id":"long-string-id","title":"中文","tags":["shared"]}`)
	q := prepared(`{"id":"long-string-id","title":"second","tags":["shared"]}`)
	q.Key = `700\second`
	q.Work["relative_path_key"], q.Work["relative_path"] = q.Key, q.Key
	if _, err := w.Batch(ctx, []PreparedWork{p, q}); err != nil {
		t.Fatal(err)
	}
	for entity, table := range map[string]string{"work": "works", "author": "authors", "media": "media", "tag": "tags"} {
		var high, maximum int64
		if err := w.DB.QueryRow("SELECT value FROM live_id_high_water WHERE entity=?", entity).Scan(&high); err != nil {
			t.Fatal(err)
		}
		if err := w.DB.QueryRow(fmt.Sprintf("SELECT max(%s_id) FROM %s", entity, table)).Scan(&maximum); err != nil || maximum != high {
			t.Fatal("high water does not match exact allocation", entity, high, maximum, err)
		}
	}
	var before int64
	w.DB.QueryRow("SELECT value FROM live_id_high_water WHERE entity='work'").Scan(&before)
	tx, err := w.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	tr := transaction{ctx: ctx, tx: tx, owner: w, stmt: map[string]*sql.Stmt{}}
	for i := int64(1); i <= 100; i++ {
		id, err := tr.id("work")
		if err != nil || id != before+i {
			t.Fatal("local allocation changed sequence", id, err)
		}
	}
	w.failAfter = w.statements + 1
	if err := tr.commit(); err == nil {
		t.Fatal("allocation flush failure did not abort")
	}
	tr.close()
	tx.Rollback()
	w.failAfter = 0
	var after int64
	w.DB.QueryRow("SELECT value FROM live_id_high_water WHERE entity='work'").Scan(&after)
	if before != after {
		t.Fatal("rolled back allocations leaked", before, after)
	}
	r := prepared(`{"id":"new","title":"third"}`)
	r.Key = `700\third`
	r.Work["relative_path_key"], r.Work["relative_path"] = r.Key, r.Key
	if _, err := w.Batch(ctx, []PreparedWork{r}); err != nil {
		t.Fatal(err)
	}
	w.DB.QueryRow("SELECT value FROM live_id_high_water WHERE entity='work'").Scan(&after)
	if after != before+1 {
		t.Fatal("allocator burned unused IDs", after, before)
	}
	if err := w.Verify(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestNewMediaConstraintFailureRollsBackWholeBatch(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	p := prepared(`{"id":"new","title":"synthetic"}`)
	p.Media = append(p.Media, copyRow(p.Media[0]))
	revision, _ := w.Revision(ctx)
	if _, err := w.Batch(ctx, []PreparedWork{p}); err == nil {
		t.Fatal("duplicate observed media key accepted")
	}
	var works, ids int64
	w.DB.QueryRow("SELECT count(*) FROM works").Scan(&works)
	w.DB.QueryRow("SELECT sum(value) FROM live_id_high_water").Scan(&ids)
	next, _ := w.Revision(ctx)
	if works != 0 || ids != 0 || next != revision {
		t.Fatal("constraint error leaked partial batch or ID", works, ids, next, revision)
	}
	if err := w.Verify(ctx); err != nil {
		t.Fatal(err)
	}
}
