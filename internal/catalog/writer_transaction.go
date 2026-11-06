package catalog

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"time"
)

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
