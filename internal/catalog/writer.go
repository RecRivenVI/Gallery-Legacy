package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	_ "modernc.org/sqlite"
	"net/url"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

type Writer struct {
	DB                     *sql.DB
	candidates             map[string]PreparedWork
	failAfter              int
	statements             int
	LastAdded, LastUpdated int64
	Metrics                WriteMetrics
	prepared               map[string]*sql.Stmt
	insertPlans            insertPlanCache
}

// Keep the automatic fallback bounded, but coalesce hot page writes across
// several work batches. Commits still fsync their WAL with synchronous=FULL;
// the writer also keeps its periodic PASSIVE and final checkpoints. This is
// a trigger, not a hard WAL cap: an old reader can defer checkpoint progress.
const automaticCheckpointPages = 8192

// Metrics are read by the independent progress reporter. Timers do not alter
// transaction boundaries; Identity is a nested cost, not another pipeline stage.
type WriteMetrics struct {
	Catalog, Search, Commit, Identity, Verify, Checkpoint atomic.Int64
	Transactions, Allocations                             atomic.Int64
	StatementPrepares, StatementCacheHits                 atomic.Int64
	WorkCommits, AuthorCommits, MaintenanceCommits        CommitMetrics
}

type CommitMetrics struct{ Count, Nanos, MaxNanos, Over50ms atomic.Int64 }

func (m *CommitMetrics) record(elapsed int64) {
	m.Count.Add(1)
	m.Nanos.Add(elapsed)
	if elapsed > int64(50*time.Millisecond) {
		m.Over50ms.Add(1)
	}
	for peak := m.MaxNanos.Load(); elapsed > peak; peak = m.MaxNanos.Load() {
		if m.MaxNanos.CompareAndSwap(peak, elapsed) {
			break
		}
	}
}

func (m *CommitMetrics) Snapshot() map[string]int64 {
	return map[string]int64{"transactions": m.Count.Load(), "totalMs": m.Nanos.Load() / 1000000, "maxMs": m.MaxNanos.Load() / 1000000, "over50ms": m.Over50ms.Load()}
}

func Open(file string) (*Writer, error) {
	u := url.URL{Scheme: "file", Path: "/" + strings.ReplaceAll(file, "\\", "/")}
	qMode := "rw" // never create a replacement database after a bad configuration
	q := u.Query()
	q.Set("mode", qMode)
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(1500)")
	q.Add("_pragma", "synchronous(FULL)")
	// A bounded page cache avoids repeated eviction of hot Catalog/FTS pages.
	// Keep the page budget independent of the checkpoint cadence experiment.
	q.Add("_pragma", "cache_size(-32768)")
	q.Add("_pragma", fmt.Sprintf("wal_autocheckpoint(%d)", automaticCheckpointPages))
	u.RawQuery = q.Encode()
	db, e := sql.Open("sqlite", u.String())
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	var version int
	if e = db.QueryRow("SELECT schema_version FROM catalog_state WHERE singleton=1").Scan(&version); e != nil || version != 4 {
		db.Close()
		if e != nil {
			return nil, fmt.Errorf("CATALOG_V4_REQUIRED: %w", e)
		}
		return nil, errors.New("CATALOG_V4_REQUIRED")
	}
	if _, e = db.Exec("PRAGMA journal_mode=WAL"); e != nil {
		db.Close()
		return nil, e
	}
	return &Writer{DB: db, candidates: map[string]PreparedWork{}, prepared: map[string]*sql.Stmt{}}, nil
}
func (w *Writer) Close() error {
	for _, stmt := range w.prepared {
		stmt.Close()
	}
	return w.DB.Close()
}
func (w *Writer) AssertBindings(ctx context.Context, sources map[string]string) error {
	definition, err := api.LoadCatalog()
	if err != nil {
		return fmt.Errorf("load live schema contract: %w", err)
	}
	var version int
	if e := w.DB.QueryRowContext(ctx, "SELECT schema_version FROM live_meta").Scan(&version); e != nil || version != definition.LiveSchemaVersion {
		return errors.New("LIVE_SCHEMA_REQUIRED")
	}
	rows, e := w.DB.QueryContext(ctx, "SELECT platform_id,physical_root_key FROM platforms")
	if e != nil {
		return e
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id, root string
		if e = rows.Scan(&id, &root); e != nil {
			return e
		}
		expected := strings.TrimRight(strings.ToLower(strings.ReplaceAll(sources[id], "/", "\\")), "\\")
		if expected != root {
			return errors.New("LIVE_SOURCE_BINDING_MISMATCH")
		}
		count++
	}
	if count != 9 {
		return errors.New("NINE_PLATFORMS_REQUIRED")
	}
	return rows.Err()
}
func (w *Writer) Batch(ctx context.Context, works []PreparedWork) (int64, error) {
	return w.BatchWithAuthors(ctx, works, nil)
}

type AuthorEnd struct {
	Platform, Key, Fingerprint string
	Complete                   bool
}

// Complete author/profile facts join the current bounded work transaction.
// This removes separate FULL commits, not durability or atomic search updates.
func (w *Writer) BatchWithAuthors(ctx context.Context, works []PreparedWork, ends []AuthorEnd) (int64, error) {
	return w.batch(ctx, works, ends, nil, false)
}

func (w *Writer) BatchWithCompletions(ctx context.Context, works []PreparedWork, ends []AuthorEnd, authorities []PreparedWork) (int64, error) {
	return w.batch(ctx, works, ends, authorities, true)
}

func (w *Writer) batch(ctx context.Context, works []PreparedWork, ends []AuthorEnd, authorities []PreparedWork, explicit bool) (int64, error) {
	w.LastAdded, w.LastUpdated = 0, 0
	if len(ends) > 64 {
		return 0, errors.New("AUTHOR_BATCH_BUDGET_EXCEEDED")
	}
	if len(works) == 0 && len(ends) == 0 {
		return w.Revision(ctx)
	}
	tx, e := w.DB.BeginTx(ctx, nil)
	if e != nil {
		return 0, e
	}
	t := transaction{ctx: ctx, tx: tx, stmt: map[string]*sql.Stmt{}, owner: w, authors: map[int64]bool{}, tags: map[int64]bool{}, workCount: len(works), authorEndCount: len(ends)}
	defer t.close()
	defer tx.Rollback()
	var rev int64
	if e = t.get("SELECT revision+1 FROM live_meta WHERE singleton=1").Scan(&rev); e != nil {
		return 0, e
	}
	updates := map[string]PreparedWork{}
	for _, p := range works {
		if p.Work["filesystem_files_state"] != "complete" {
			return 0, errors.New("LIVE_WORK_INCOMPLETE")
		}
		if e = w.write(&t, p, rev); e != nil {
			return 0, e
		}
		if explicit {
			continue
		} // pipeline supplies the final anchor; retain no library-sized map
		k := p.Platform + "\x00" + p.AuthorKey
		prev, ok := updates[k]
		if !ok {
			prev, ok = w.candidates[k]
		}
		if !ok || later(p, prev) {
			updates[k] = p
		}
	}
	ended := map[string]bool{}
	for _, p := range authorities {
		updates[p.Platform+"\x00"+p.AuthorKey] = p
	}
	for _, end := range ends {
		key := end.Platform + "\x00" + end.Key
		p, ok := updates[key]
		if !ok {
			if explicit && end.Complete {
				return 0, errors.New("AUTHOR_ANCHOR_REQUIRED")
			}
			p, ok = w.candidates[key]
		}
		if end.Complete && ok {
			started := time.Now()
			e = w.endAuthor(&t, p, end, rev)
			w.Metrics.Catalog.Add(time.Since(started).Nanoseconds())
			if e != nil {
				return 0, e
			}
		}
		ended[key] = true
	}
	for id := range t.tags {
		started := time.Now()
		e = refreshTag(&t, id)
		w.Metrics.Search.Add(time.Since(started).Nanoseconds())
		if e != nil {
			return 0, e
		}
	}
	for id := range t.authors {
		started := time.Now()
		e = refreshAuthor(&t, id)
		w.Metrics.Search.Add(time.Since(started).Nanoseconds())
		if e != nil {
			return 0, e
		}
	}
	if len(works) > 0 || t.visible {
		if e = t.exec("UPDATE live_meta SET revision=? WHERE singleton=1", rev); e != nil {
			return 0, e
		}
	} else {
		rev-- // bookkeeping alone is not new Gallery content
	}
	if e = t.commit(); e != nil {
		return 0, e
	}
	w.LastAdded, w.LastUpdated = t.added, t.updated
	for k, p := range updates {
		if ended[k] {
			continue
		}
		// Author authority retains profile facts only, never whole work bodies or
		// media lists; the prepared queue's byte budget remains meaningful.
		w.candidates[k] = Authority(p)
	}
	for k := range ended {
		delete(w.candidates, k)
	}
	return rev, nil
}
func later(a, b PreparedWork) bool {
	if a.AuthorityTime != b.AuthorityTime {
		return a.AuthorityTime > b.AuthorityTime
	}
	if a.AuthorityID != b.AuthorityID {
		return a.AuthorityID > b.AuthorityID
	}
	return a.AuthorityName > b.AuthorityName
}
func (w *Writer) Revision(ctx context.Context) (int64, error) {
	var n int64
	e := w.DB.QueryRowContext(ctx, "SELECT revision FROM live_meta WHERE singleton=1").Scan(&n)
	return n, e
}
func (w *Writer) Checkpoint(ctx context.Context) error {
	started := time.Now()
	defer func() { w.Metrics.Checkpoint.Add(time.Since(started).Nanoseconds()) }()
	_, e := w.DB.ExecContext(ctx, "PRAGMA wal_checkpoint(PASSIVE)")
	return e
}

func (w *Writer) Verify(ctx context.Context) error {
	checks := []string{"SELECT count(*) FROM pragma_foreign_key_check", "SELECT count(*) FROM works w WHERE media_count<>(SELECT count(*) FROM media m WHERE m.work_id=w.work_id)", "SELECT count(*) FROM authors a WHERE work_count<>(SELECT count(*) FROM works w WHERE w.author_id=a.author_id)", "SELECT count(*) FROM tags t WHERE work_count<>(SELECT count(*) FROM work_tags wt WHERE wt.tag_id=t.tag_id)", "SELECT count(*) FROM metadata_shapes s WHERE work_count<>(SELECT count(*) FROM works w WHERE w.metadata_shape_id=s.metadata_shape_id)", "SELECT abs((SELECT works FROM live_stats)-(SELECT count(*) FROM works))", "SELECT abs((SELECT media FROM live_stats)-(SELECT count(*) FROM media))", "SELECT abs((SELECT authors FROM live_stats)-(SELECT count(*) FROM authors))", "SELECT abs((SELECT count(*) FROM works)-(SELECT count(*) FROM live_work_fts))"}
	for i, q := range checks {
		var count int64
		started := time.Now()
		e := w.DB.QueryRowContext(ctx, q).Scan(&count)
		w.Metrics.Verify.Add(time.Since(started).Nanoseconds())
		if e != nil {
			return e
		}
		if count != 0 {
			return fmt.Errorf("CATALOG_VERIFY_%d", i)
		}
	}
	return nil
}
func SortedPlatforms() []string {
	a := []string{}
	for k := range metadata.Versions {
		a = append(a, k)
	}
	sort.Strings(a)
	return a
}
