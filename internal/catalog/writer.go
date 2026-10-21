package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"math"
	_ "modernc.org/sqlite"
	"net/url"
	"regexp"
	"sort"
	"strconv"
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
	var version int
	if e := w.DB.QueryRowContext(ctx, "SELECT schema_version FROM live_meta").Scan(&version); e != nil || version != 3 {
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
func (w *Writer) EmptyAuthor(ctx context.Context, a Row) error {
	tx, e := w.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	t := transaction{ctx: ctx, tx: tx, stmt: map[string]*sql.Stmt{}, owner: w}
	defer t.close()
	var id int64
	e = t.get("SELECT author_id FROM authors WHERE platform_id=? AND relative_path_key=?", a["platform_id"], a["relative_path_key"]).Scan(&id)
	if e == sql.ErrNoRows {
		id, e = t.id("author")
		if e != nil {
			return e
		}
		a = copyRow(a)
		a["author_id"] = id
		if e = t.insert("authors", a, ""); e != nil {
			return e
		}
		if e = t.exec("UPDATE live_stats SET authors=authors+1"); e != nil {
			return e
		}
		if e = t.exec("UPDATE live_meta SET revision=revision+1"); e != nil {
			return e
		}
		if e = t.exec("UPDATE live_platform_stats SET last_revision=(SELECT revision FROM live_meta) WHERE platform_id=?", a["platform_id"]); e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	if e = refreshAuthor(&t, id); e != nil {
		return e
	}
	return t.commit()
}

// Remove is called only by the sealed-scope reconciler after native ENOENT.
func (w *Writer) Remove(ctx context.Context, id int64) error {
	tx, e := w.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	t := transaction{ctx: ctx, tx: tx, stmt: map[string]*sql.Stmt{}, owner: w}
	defer t.close()
	var platform, state string
	var author, media int64
	var shape sql.NullInt64
	var key string
	if e = t.get("SELECT platform_id,author_id,media_count,metadata_state,metadata_shape_id,relative_path_key FROM works WHERE work_id=?", id).Scan(&platform, &author, &media, &state, &shape, &key); e != nil {
		return e
	}
	rows, e := t.query("SELECT tag_id FROM work_tags WHERE work_id=?", id)
	if e != nil {
		return e
	}
	tags := []int64{}
	for rows.Next() {
		var tag int64
		if e = rows.Scan(&tag); e != nil {
			rows.Close()
			return e
		}
		tags = append(tags, tag)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, table := range []string{"live_work_sort", "live_search_docs", "live_work_tags", "live_work_fts", "live_short_fts"} {
		column := "work_id"
		if strings.HasSuffix(table, "fts") {
			column = "rowid"
		}
		if e = t.exec("DELETE FROM "+table+" WHERE "+column+"=?", id); e != nil {
			return e
		}
	}
	if e = t.exec("DELETE FROM works WHERE work_id=?", id); e != nil {
		return e
	}
	if e = t.exec("DELETE FROM live_scan_works WHERE platform_id=? AND relative_path_key=?", platform, key); e != nil {
		return e
	}
	for _, tag := range tags {
		if e = t.exec("UPDATE tags SET work_count=work_count-1 WHERE tag_id=?", tag); e != nil {
			return e
		}
		if e = refreshTag(&t, tag); e != nil {
			return e
		}
	}
	if shape.Valid {
		if e = t.exec("UPDATE metadata_shapes SET work_count=work_count-1 WHERE metadata_shape_id=?", shape.Int64); e != nil {
			return e
		}
	}
	for _, op := range []struct {
		q    string
		args []any
	}{
		{"UPDATE authors SET work_count=work_count-1 WHERE author_id=?", []any{author}},
		{"UPDATE live_stats SET works=works-1,media=media-?", []any{media}},
		{"UPDATE live_metadata_stats SET count=count-1 WHERE metadata_state=?", []any{state}},
		{"UPDATE live_meta SET revision=revision+1", nil},
		{"UPDATE live_platform_stats SET count_works=count_works-1,count_media=count_media-?,last_revision=(SELECT revision FROM live_meta) WHERE platform_id=?", []any{media, platform}},
	} {
		if e = t.exec(op.q, op.args...); e != nil {
			return e
		}
	}
	if e = refreshAuthor(&t, author); e != nil {
		return e
	}
	return t.commit()
}

// RemoveAuthor requires a sealed listing and a native-confirmed absent directory.
// It refuses an author that still owns any physical work.
func (w *Writer) RemoveAuthor(ctx context.Context, platform, key string) error {
	tx, e := w.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	t := transaction{ctx: ctx, tx: tx, stmt: map[string]*sql.Stmt{}, owner: w}
	defer t.close()
	var id, count int64
	if e = t.get("SELECT author_id,work_count FROM authors WHERE platform_id=? AND relative_path_key=?", platform, key).Scan(&id, &count); e != nil {
		return e
	}
	if count != 0 {
		return errors.New("AUTHOR_STILL_HAS_WORKS")
	}
	for _, op := range []struct {
		q    string
		args []any
	}{
		{"DELETE FROM live_authors WHERE author_id=?", []any{id}},
		{"DELETE FROM authors WHERE author_id=?", []any{id}},
		{"DELETE FROM live_scan_authors WHERE platform_id=? AND relative_path_key=?", []any{platform, key}},
		{"UPDATE live_stats SET authors=authors-1", nil},
		{"UPDATE live_meta SET revision=revision+1", nil},
		{"UPDATE live_platform_stats SET last_revision=(SELECT revision FROM live_meta) WHERE platform_id=?", []any{platform}},
	} {
		if e = t.exec(op.q, op.args...); e != nil {
			return e
		}
	}
	return t.commit()
}

type transaction struct {
	ctx                       context.Context
	tx                        *sql.Tx
	stmt                      map[string]*sql.Stmt
	owner                     *Writer
	authors, tags             map[int64]bool
	added, updated            int64
	ids                       map[string]int64
	workCount, authorEndCount int
	visible                   bool
	normalizer                func(string) string
}

func (t *transaction) normalize(value string) string {
	if t.normalizer != nil {
		return t.normalizer(value)
	}
	return Normalize(value)
}

func (t *transaction) exec(query string, args ...any) error {
	t.owner.statements++
	if t.owner.failAfter > 0 && t.owner.statements == t.owner.failAfter {
		return errors.New("INJECTED_TRANSACTION_FAILURE")
	}
	s, e := t.statement(query)
	if e != nil {
		return e
	}
	_, e = s.ExecContext(t.ctx, args...)
	return e
}

type rowScanner interface{ Scan(...any) error }
type queryError struct{ err error }

func (e queryError) Scan(...any) error { return e.err }
func (t *transaction) get(query string, args ...any) rowScanner {
	s, e := t.statement(query)
	if e != nil {
		return queryError{e}
	}
	return s.QueryRowContext(t.ctx, args...)
}
func (t *transaction) query(query string, args ...any) (*sql.Rows, error) {
	s, e := t.statement(query)
	if e != nil {
		return nil, e
	}
	return s.QueryContext(t.ctx, args...)
}
func (t *transaction) statement(query string) (*sql.Stmt, error) {
	if s := t.stmt[query]; s != nil {
		return s, nil
	}
	var s *sql.Stmt
	var e error
	if cached := t.owner.prepared[query]; cached != nil {
		s = t.tx.StmtContext(t.ctx, cached)
		t.owner.Metrics.StatementCacheHits.Add(1)
	} else {
		s, e = t.tx.PrepareContext(t.ctx, query)
		t.owner.Metrics.StatementPrepares.Add(1)
	}
	if e == nil {
		t.stmt[query] = s
	}
	return s, e
}
func (t *transaction) close() {
	for _, s := range t.stmt {
		s.Close()
	}
}
func (t *transaction) id(entity string) (int64, error) {
	if t.ids == nil {
		t.ids = map[string]int64{}
	}
	id, loaded := t.ids[entity]
	if !loaded {
		started := time.Now()
		e := t.get("SELECT value FROM live_id_high_water WHERE entity=?", entity).Scan(&id)
		t.owner.Metrics.Identity.Add(time.Since(started).Nanoseconds())
		if e != nil {
			return 0, e
		}
	}
	if id == math.MaxInt64 {
		return 0, errors.New("IDENTITY_EXHAUSTED")
	}
	id++
	t.owner.Metrics.Allocations.Add(1)
	t.ids[entity] = id
	return id, nil
}

// IDs are allocated in the isolated writer transaction and persisted once per
// entity, together with the corresponding Catalog/Search rows. Rollback never
// advances an allocator in memory across transactions or burns unused ranges.
func (t *transaction) commit() error {
	started := time.Now()
	for entity, value := range t.ids {
		if e := t.exec("UPDATE live_id_high_water SET value=? WHERE entity=?", value, entity); e != nil {
			t.owner.Metrics.Identity.Add(time.Since(started).Nanoseconds())
			return e
		}
	}
	t.owner.Metrics.Identity.Add(time.Since(started).Nanoseconds())
	started = time.Now()
	e := t.tx.Commit()
	elapsed := time.Since(started).Nanoseconds()
	t.owner.Metrics.Commit.Add(elapsed)
	if e == nil {
		t.owner.Metrics.Transactions.Add(1)
		metrics := &t.owner.Metrics.MaintenanceCommits
		if t.workCount > 0 {
			metrics = &t.owner.Metrics.WorkCommits
		} else if t.authorEndCount > 0 {
			metrics = &t.owner.Metrics.AuthorCommits
		}
		metrics.record(elapsed)
		// Prepare DB-owned statements only AFTER the Tx released the sole
		// connection. Tx-owned statements are unusable after commit. Cache
		// warming is optional and can never turn a confirmed commit into failure.
		for query := range t.stmt {
			if len(t.owner.prepared) >= 128 {
				break
			}
			if t.owner.prepared[query] != nil {
				continue
			}
			s, err := t.owner.DB.PrepareContext(t.ctx, query)
			if err == nil {
				t.owner.prepared[query] = s
				t.owner.Metrics.StatementPrepares.Add(1)
			}
		}
	}
	return e
}
func (t *transaction) insert(table string, r Row, conflict string) error {
	p := t.owner.insertPlans.plan(table, conflict, r)
	args := make([]any, len(p.columns))
	for i, k := range p.columns {
		args[i] = r[k]
	}
	return t.exec(p.query, args...)
}
func copyRow(x Row) Row {
	o := Row{}
	for k, v := range x {
		o[k] = v
	}
	return o
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
func (w *Writer) write(t *transaction, p PreparedWork, rev int64) error {
	started := time.Now()
	var searchTime int64
	defer func() { w.Metrics.Catalog.Add(time.Since(started).Nanoseconds() - searchTime) }()
	var authorID int64
	e := t.get("SELECT author_id FROM authors WHERE platform_id=? AND relative_path_key=?", p.Platform, p.AuthorKey).Scan(&authorID)
	if e == sql.ErrNoRows {
		authorID, e = t.id("author")
		if e != nil {
			return e
		}
		r := copyRow(p.Author)
		r["author_id"] = authorID
		if e = t.insert("authors", r, ""); e != nil {
			return e
		}
		if e = t.exec("UPDATE live_stats SET authors=authors+1 WHERE singleton=1"); e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	var workID, oldMedia int64
	var oldState string
	var oldSource sql.NullString
	var oldShape sql.NullInt64
	exists := true
	e = t.get("SELECT work_id,media_count,metadata_state,metadata_shape_id,source_work_id FROM works WHERE platform_id=? AND relative_path_key=?", p.Platform, p.Key).Scan(&workID, &oldMedia, &oldState, &oldShape, &oldSource)
	if e == sql.ErrNoRows {
		exists = false
		workID, e = t.id("work")
	}
	if e != nil {
		return e
	}
	if exists {
		t.updated++
	} else {
		t.added++
	}
	oldTags := []int64{}
	var rows *sql.Rows
	if exists {
		rows, e = t.query("SELECT tag_id FROM work_tags WHERE work_id=?", workID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var id int64
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return e
			}
			oldTags = append(oldTags, id)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
	}
	var shapeID any
	if p.Shape != nil {
		r := copyRow(p.Shape)
		r["first_seen_at_ms"] = time.Now().UnixMilli()
		r["last_seen_at_ms"] = r["first_seen_at_ms"]
		var id int64
		e = t.get("SELECT metadata_shape_id FROM metadata_shapes WHERE platform_id=? AND signature_version=1 AND policy_version=1 AND shape_hash=?", p.Platform, r["shape_hash"]).Scan(&id)
		if e == sql.ErrNoRows {
			if e = t.insert("metadata_shapes", r, ""); e != nil {
				return e
			}
			if e = t.get("SELECT metadata_shape_id FROM metadata_shapes WHERE platform_id=? AND shape_hash=?", p.Platform, r["shape_hash"]).Scan(&id); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		shapeID = id
		if e = t.exec("UPDATE metadata_shapes SET last_seen_at_ms=?,representative_metadata_relative_path=min(coalesce(representative_metadata_relative_path,?),?) WHERE metadata_shape_id=?", r["last_seen_at_ms"], r["representative_metadata_relative_path"], r["representative_metadata_relative_path"], id); e != nil {
			return e
		}
	}
	if oldShape.Valid && (shapeID == nil || shapeID != oldShape.Int64) {
		if e = t.exec("UPDATE metadata_shapes SET work_count=work_count-1 WHERE metadata_shape_id=?", oldShape.Int64); e != nil {
			return e
		}
	}
	if shapeID != nil && (!oldShape.Valid || shapeID != oldShape.Int64) {
		if e = t.exec("UPDATE metadata_shapes SET work_count=work_count+1 WHERE metadata_shape_id=?", shapeID); e != nil {
			return e
		}
	}
	r := copyRow(p.Work)
	r["work_id"] = workID
	r["author_id"] = authorID
	r["metadata_shape_id"] = shapeID
	workConflict := ""
	if exists {
		workConflict = "platform_id,relative_path_key"
	}
	if e = t.insert("works", r, workConflict); e != nil {
		return e
	}
	if exists {
		for _, table := range []string{"work_access", "work_text", "work_text_sources", "structured_sources", "field_sources", "work_tags", "social_relations", "work_metrics", "media_declarations"} {
			if e = t.exec("DELETE FROM "+table+" WHERE work_id=?", workID); e != nil {
				return e
			}
		}
	}
	for _, id := range oldTags {
		if e = t.exec("UPDATE tags SET work_count=work_count-1 WHERE tag_id=?", id); e != nil {
			return e
		}
	}
	for table, children := range p.Children {
		seen := map[string]bool{}
		for _, c := range children {
			x := copyRow(c)
			x["work_id"] = workID
			if table == "field_sources" {
				key := metadata.JSON(c)
				if seen[key] {
					continue
				}
				seen[key] = true
			}
			if table == "social_relations" {
				var id sql.NullInt64
				if e = t.get("SELECT CASE WHEN count(*)=1 THEN min(work_id) END FROM works WHERE platform_id=? AND source_work_id=?", p.Platform, c["target_source_work_id"]).Scan(&id); e != nil {
					return e
				}
				if id.Valid {
					x["target_work_id"] = id.Int64
				}
			}
			if e = t.insert(table, x, ""); e != nil {
				return e
			}
		}
	}
	for i, tag := range p.Normalized.Tags {
		var id int64
		e = t.get("SELECT tag_id FROM tags WHERE display_value=?", tag).Scan(&id)
		if e == sql.ErrNoRows {
			id, e = t.id("tag")
			if e != nil {
				return e
			}
			if e = t.insert("tags", Row{"tag_id": id, "display_value": tag, "normalized_value": nil, "work_count": int64(0)}, ""); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		if e = t.insert("work_tags", Row{"tag_id": id, "work_id": workID, "ordinal": i, "sort_at_ms": p.Work["sort_at_ms"]}, ""); e != nil {
			return e
		}
		if e = t.exec("UPDATE tags SET work_count=work_count+1 WHERE tag_id=?", id); e != nil {
			return e
		}
	}
	oldIDs := map[string]int64{}
	if exists {
		rows, e = t.query("SELECT relative_path_key,media_id FROM media WHERE work_id=?", workID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var key string
			var id int64
			if e = rows.Scan(&key, &id); e != nil {
				rows.Close()
				return e
			}
			oldIDs[key] = id
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
	}
	ids := map[string]int64{}
	for _, m := range p.Media {
		x := copyRow(m)
		key := text(x["relative_path_key"])
		id := oldIDs[key]
		mediaConflict := "work_id,relative_path_key"
		if id == 0 {
			mediaConflict = ""
			id, e = t.id("media")
			if e != nil {
				return e
			}
		}
		x["media_id"] = id
		x["work_id"] = workID
		ids[key] = id
		delete(oldIDs, key)
		if e = t.insert("media", x, mediaConflict); e != nil {
			return e
		}
	}
	for _, id := range oldIDs {
		if e = t.exec("DELETE FROM media WHERE media_id=?", id); e != nil {
			return e
		}
	}
	for _, d := range p.Declarations {
		x := copyRow(d)
		x["work_id"] = workID
		if text(x["match_state"]) == "matched" {
			x["matched_media_id"] = ids[text(x["match_key"])]
		}
		delete(x, "match_key")
		if e = t.insert("media_declarations", x, ""); e != nil {
			return e
		}
	}
	delta := int64(0)
	if !exists {
		delta = 1
		if e = t.exec("UPDATE authors SET work_count=work_count+1 WHERE author_id=?", authorID); e != nil {
			return e
		}
	}
	if e = t.exec("UPDATE live_stats SET works=works+?,media=media+? WHERE singleton=1", delta, int64(len(p.Media))-oldMedia); e != nil {
		return e
	}
	if e = t.exec("UPDATE live_platform_stats SET count_works=count_works+?,count_media=count_media+?,last_revision=? WHERE platform_id=?", delta, int64(len(p.Media))-oldMedia, rev, p.Platform); e != nil {
		return e
	}
	if oldState != "" {
		if e = t.exec("UPDATE live_metadata_stats SET count=count-1 WHERE metadata_state=?", oldState); e != nil {
			return e
		}
	}
	if e = t.exec("INSERT INTO live_metadata_stats VALUES (?,1) ON CONFLICT(metadata_state) DO UPDATE SET count=count+1", p.Work["metadata_state"]); e != nil {
		return e
	}
	if p.Qualified {
		if e = t.exec("INSERT INTO live_scan_works VALUES (?,?,?,?,?,?) ON CONFLICT(platform_id,relative_path_key) DO UPDATE SET fingerprint=excluded.fingerprint,adapter_version=excluded.adapter_version,authority_at_ms=excluded.authority_at_ms,authority_source_id=excluded.authority_source_id", p.Platform, p.Key, p.Fingerprint, metadata.Versions[p.Platform], p.AuthorityTime, p.AuthorityID); e != nil {
			return e
		}
	} else {
		if e = t.exec("DELETE FROM live_scan_works WHERE platform_id=? AND relative_path_key=?", p.Platform, p.Key); e != nil {
			return e
		}
	}
	if e = t.exec(`UPDATE social_relations SET target_work_id=(SELECT CASE WHEN count(*)=1 THEN min(work_id) END FROM works WHERE platform_id=? AND source_work_id=?) WHERE target_platform_id=? AND target_source_work_id=?`, p.Platform, p.Work["source_work_id"], p.Platform, p.Work["source_work_id"]); e != nil {
		return e
	}
	if oldSource.Valid && oldSource.String != text(p.Work["source_work_id"]) {
		if e = t.exec(`UPDATE social_relations SET target_work_id=(SELECT CASE WHEN count(*)=1 THEN min(work_id) END FROM works WHERE platform_id=? AND source_work_id=?) WHERE target_platform_id=? AND target_source_work_id=?`, p.Platform, oldSource.String, p.Platform, oldSource.String); e != nil {
			return e
		}
	}
	searchStarted := time.Now()
	e = refreshWork(t, workID, exists)
	searchTime = time.Since(searchStarted).Nanoseconds()
	w.Metrics.Search.Add(searchTime)
	if e != nil {
		return e
	}
	for _, tag := range oldTags {
		t.tags[tag] = true
	}
	t.authors[authorID] = true
	return nil
}
func (w *Writer) EndAuthor(ctx context.Context, platform, key, fingerprint string, complete bool) error {
	_, e := w.BatchWithAuthors(ctx, nil, []AuthorEnd{{platform, key, fingerprint, complete}})
	return e
}
func (w *Writer) endAuthor(t *transaction, p PreparedWork, end AuthorEnd, rev int64) error {
	platform, key, fingerprint := end.Platform, end.Key, end.Fingerprint
	if !p.Qualified && p.Key != "" {
		fingerprint = ""
		if e := t.exec("DELETE FROM live_scan_works WHERE platform_id=? AND relative_path_key=?", platform, p.Key); e != nil {
			return e
		}
	}
	var authorID, workID int64
	var shape sql.NullInt64
	if p.Key == "" {
		if e := t.get("SELECT author_id FROM authors WHERE platform_id=? AND relative_path_key=?", platform, key).Scan(&authorID); e != nil {
			return e
		}
	} else {
		if e := t.get("SELECT author_id,work_id,metadata_shape_id FROM works WHERE platform_id=? AND relative_path_key=?", platform, p.Key).Scan(&authorID, &workID, &shape); e != nil {
			return e
		}
	}
	var e error
	state := "unavailable"
	if p.Work["metadata_state"] == "malformed" || p.Work["metadata_state"] == "non_object" || p.Work["metadata_state"] == "partial" {
		state = "invalid"
	}
	if p.Normalized.Valid {
		state = "valid"
	}
	a := copyRow(p.Author)
	a["author_id"] = authorID
	delete(a, "work_count")
	delete(a, "name_rank")
	a["latest_work_at_ms"] = nil
	a["latest_work_id"] = nil
	a["profile_state"] = state
	a["handle"] = nil
	var profile Row
	if p.Normalized.Valid {
		a["latest_work_at_ms"] = p.Work["sort_at_ms"]
		a["latest_work_id"] = workID
		a["handle"] = p.Normalized.Profile["handle"]
		profile = copyRow(p.Profile)
		profile["author_id"] = authorID
		profile["authority_work_id"] = workID
		if shape.Valid {
			profile["metadata_shape_id"] = shape.Int64
		}
	}
	authorSame, e := rowMatches(t, "authors", "author_id", authorID, a)
	if e != nil {
		return e
	}
	profileSame := false
	if profile != nil {
		profileSame, e = rowMatches(t, "author_profiles", "author_id", authorID, profile)
	} else {
		var exists int
		e = t.get("SELECT EXISTS(SELECT 1 FROM author_profiles WHERE author_id=?)", authorID).Scan(&exists)
		profileSame = exists == 0
	}
	if e != nil {
		return e
	}
	if !authorSame || !profileSame {
		t.visible = true
		if e = t.exec("DELETE FROM author_profiles WHERE author_id=?", authorID); e != nil {
			return e
		}
		if e = t.exec("DELETE FROM author_aliases WHERE author_id=?", authorID); e != nil {
			return e
		}
		if p.Normalized.Valid {
			if e = t.insert("author_profiles", profile, ""); e != nil {
				return e
			}
			for _, pair := range [][2]string{{"display_name", "displayName"}, {"handle", "handle"}} {
				if s := text(p.Normalized.Profile[pair[1]]); s != "" {
					if e = t.insert("author_aliases", Row{"author_id": authorID, "platform_id": platform, "alias_kind": pair[0], "display_value": s, "normalized_value": nil}, ""); e != nil {
						return e
					}
				}
			}
		}
		keys := SortedKeys(a)
		sets := []string{}
		args := []any{}
		for _, k := range keys {
			if k == "author_id" || k == "platform_id" || k == "relative_path_key" {
				continue
			}
			sets = append(sets, k+"=?")
			args = append(args, a[k])
		}
		args = append(args, authorID)
		if e = t.exec("UPDATE authors SET "+strings.Join(sets, ",")+" WHERE author_id=?", args...); e != nil {
			return e
		}
		t.authors[authorID] = true
		if e = t.exec("UPDATE live_platform_stats SET last_revision=? WHERE platform_id=?", rev, platform); e != nil {
			return e
		}
	}
	if fingerprint != "" {
		if e = t.exec("INSERT INTO live_scan_authors VALUES (?,?,?) ON CONFLICT(platform_id,relative_path_key) DO UPDATE SET fingerprint=excluded.fingerprint", platform, key, fingerprint); e != nil {
			return e
		}
	} else {
		if e = t.exec("DELETE FROM live_scan_authors WHERE platform_id=? AND relative_path_key=?", platform, key); e != nil {
			return e
		}
	}
	return nil
}

// Compare only the small profile projection, never work bodies or media lists.
func rowMatches(t *transaction, table, primary string, id int64, expected Row) (bool, error) {
	keys := SortedKeys(expected)
	values := make([]any, len(keys))
	destinations := make([]any, len(keys))
	for i := range values {
		destinations[i] = &values[i]
	}
	e := t.get("SELECT "+strings.Join(keys, ",")+" FROM "+table+" WHERE "+primary+"=?", id).Scan(destinations...)
	if e == sql.ErrNoRows {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	for i, k := range keys {
		if metadata.JSON(values[i]) != metadata.JSON(expected[k]) {
			return false, nil
		}
	}
	return true, nil
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

var markup = regexp.MustCompile(`<[^>]{0,1000}[^>]{0,1000}[^>]{0,48}>`)
var invisible = regexp.MustCompile(`[\x{200b}-\x{200f}\x{2060}\x{feff}]`)
var namedEntity = regexp.MustCompile(`(?i)&(?:amp|lt|gt|quot|apos|#39);`)
var numericEntity = regexp.MustCompile(`(?i)&#(?:x([0-9a-f]+)|(\d+));`)

func Normalize(s string) string {
	return normalizeSpaces(normalizedText(s))
}

func normalizedText(s string) string {
	s = norm.NFKC.String(s)
	if strings.ContainsAny(s, "\u200b\u200c\u200d\u200e\u200f\u2060\ufeff") {
		s = invisible.ReplaceAllString(s, "")
	}
	if strings.Contains(s, "<") {
		s = markup.ReplaceAllString(s, " ")
	}
	if strings.Contains(s, "&") {
		s = namedEntity.ReplaceAllStringFunc(s, decodeNamedEntity)
	}
	if strings.Contains(s, "&#") {
		s = numericEntity.ReplaceAllStringFunc(s, decodeNumericEntity)
	}
	return cases.Lower(language.Und).String(s)
}

func decodeNamedEntity(e string) string {
	return map[string]string{"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&#39;": "'"}[strings.ToLower(e)]
}

func decodeNumericEntity(e string) string {
	m := numericEntity.FindStringSubmatch(e)
	base := 10
	v := m[2]
	if m[1] != "" {
		base = 16
		v = m[1]
	}
	n, err := strconv.ParseInt(v, base, 32)
	if err != nil || n < 0 || n > 0x10ffff {
		return " "
	}
	return string(rune(n))
}
func refreshWork(t *transaction, id int64, exists bool) error {
	if exists {
		for _, table := range []string{"live_work_sort", "live_search_docs", "live_work_tags", "live_work_fts", "live_short_fts"} {
			column := "work_id"
			if strings.HasSuffix(table, "fts") {
				column = "rowid"
			}
			if e := t.exec("DELETE FROM "+table+" WHERE "+column+"=?", id); e != nil {
				return e
			}
		}
	}
	var platform, title, relative, author, tags, body string
	var source sql.NullString
	var authorID, sortAt, images, videos int64
	e := t.get(`SELECT w.platform_id,w.author_id,w.sort_at_ms,w.title,w.relative_path,w.source_work_id,a.display_name||' '||coalesce(a.handle,'')||' '||coalesce(a.source_author_id,''),coalesce(x.source_text,''),w.image_count,w.video_count FROM works w JOIN authors a USING(author_id) LEFT JOIN work_text x USING(work_id) WHERE w.work_id=?`, id).Scan(&platform, &authorID, &sortAt, &title, &relative, &source, &author, &body, &images, &videos)
	if e != nil {
		return e
	}
	rows, e := t.query("SELECT t.display_value,wt.tag_id FROM work_tags wt JOIN tags t USING(tag_id) WHERE wt.work_id=? ORDER BY wt.ordinal", id)
	if e != nil {
		return e
	}
	tagIDs := []int64{}
	names := []string{}
	for rows.Next() {
		var name string
		var tag int64
		if e = rows.Scan(&name, &tag); e != nil {
			rows.Close()
			return e
		}
		names = append(names, name)
		tagIDs = append(tagIDs, tag)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	tags = strings.Join(names, " ")
	var extracted int
	e = t.get("SELECT EXISTS(SELECT 1 FROM field_sources WHERE work_id=? AND field='media.extractedPreviews')", id).Scan(&extracted)
	if e != nil {
		return e
	}
	readable := 0
	rows, e = t.query("SELECT filesystem_file_name FROM media WHERE work_id=?", id)
	if e != nil {
		return e
	}
	for rows.Next() {
		var name string
		if e = rows.Scan(&name); e != nil {
			rows.Close()
			return e
		}
		if presentation(name, extracted == 1) {
			readable = 1
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	image, video := 0, 0
	if images > 0 {
		image = 1
	}
	if videos > 0 {
		video = 1
	}
	normalizedTitle, normalizedTags, normalizedBody, normalizedSource := t.normalize(title), t.normalize(tags), t.normalize(body), t.normalize(source.String)
	if e = t.exec("INSERT INTO live_work_sort VALUES (?,?,?,?,?,?,?,?,?)", id, platform, authorID, sortAt, normalizedTitle, t.normalize(basename(relative)), image, video, readable); e != nil {
		return e
	}
	doc := []any{id, platform, t.normalize(title + " " + source.String), t.normalize(author), normalizedTags, normalizedBody}
	if e = t.exec("INSERT INTO live_search_docs VALUES (?,?,?,?,?,?)", doc...); e != nil {
		return e
	}
	if e = t.exec("INSERT INTO live_work_fts(rowid,title,author,tags,body) VALUES (?,?,?,?,?)", id, doc[2], "", doc[4], doc[5]); e != nil {
		return e
	}
	grams := []string{}
	seen := map[rune]bool{}
	for _, s := range []string{normalizedTitle, normalizedTags, normalizedSource, normalizedBody} {
		for _, r := range s {
			if r != ' ' && !seen[r] {
				seen[r] = true
				grams = append(grams, "u"+strconv.FormatInt(int64(r), 16))
			}
		}
	}
	if e = t.exec("INSERT INTO live_short_fts(rowid,terms) VALUES (?,?)", id, strings.Join(grams, " ")); e != nil {
		return e
	}
	for _, tag := range tagIDs {
		if e = t.exec("INSERT INTO live_work_tags VALUES (?,?)", id, tag); e != nil {
			return e
		}
		t.tags[tag] = true
	}
	return nil
}
func refreshAuthor(t *transaction, id int64) error {
	var platform, key, name string
	var source sql.NullString
	var latest sql.NullInt64
	var count int64
	e := t.get("SELECT platform_id,relative_path_key,source_author_id,display_name||' '||coalesce(handle,'')||' '||coalesce(source_author_id,''),latest_work_at_ms,work_count FROM authors WHERE author_id=?", id).Scan(&platform, &key, &source, &name, &latest, &count)
	if e != nil {
		return e
	}
	identity := key
	if source.Valid {
		identity = source.String
	}
	at := int64(-9223372036854775808)
	if latest.Valid {
		at = latest.Int64
	}
	if e = t.exec("DELETE FROM live_authors WHERE author_id=?", id); e != nil {
		return e
	}
	return t.exec("INSERT INTO live_authors VALUES (?,?,?,?,?,?,?,?)", id, platform, key, source, identity, t.normalize(name), at, count)
}
func refreshTag(t *transaction, id int64) error {
	var name string
	var count int64
	if e := t.get("SELECT display_value,work_count FROM tags WHERE tag_id=?", id).Scan(&name, &count); e != nil {
		return e
	}
	if e := t.exec("DELETE FROM live_tags WHERE tag_id=?", id); e != nil {
		return e
	}
	return t.exec("INSERT INTO live_tags VALUES (?,?,?,?)", id, name, t.normalize(name), count)
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
