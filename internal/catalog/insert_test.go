package catalog

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func referenceInsert(table string, r Row, conflict string) ([]string, string) {
	keys := SortedKeys(r)
	marks := make([]string, len(keys))
	updates := []string{}
	for i, k := range keys {
		marks[i] = "?"
		primary := map[string]string{"works": "work_id", "authors": "author_id", "media": "media_id", "tags": "tag_id"}[table]
		if k != primary {
			updates = append(updates, k+"=excluded."+k)
		}
	}
	q := "INSERT INTO " + table + "(" + strings.Join(keys, ",") + ") VALUES (" + strings.Join(marks, ",") + ")"
	if conflict != "" {
		if len(updates) == 0 {
			q += " ON CONFLICT(" + conflict + ") DO NOTHING"
		} else {
			q += " ON CONFLICT(" + conflict + ") DO UPDATE SET " + strings.Join(updates, ",")
		}
	}
	return keys, q
}

func TestInsertPlansPreserveColumnsNullsAndConflictSemantics(t *testing.T) {
	var c insertPlanCache
	for _, table := range []string{"works", "authors", "media", "tags", "field_sources"} {
		for _, conflict := range []string{"", "platform_id,relative_path_key"} {
			for _, r := range []Row{{"work_id": int64(7)}, {"title": nil, "work_id": int64(1)}, {"author_id": int64(1), "title": "synthetic-only-value"}, {"media_id": int64(8), "tag_id": int64(3)}} {
				wantKeys, wantSQL := referenceInsert(table, r, conflict)
				p := c.plan(table, conflict, r)
				if !reflect.DeepEqual(wantKeys, p.columns) || wantSQL != p.query {
					t.Fatal("query changed", table, conflict)
				}
				if strings.Contains(p.query, "synthetic-only-value") {
					t.Fatal("row value retained")
				}
				x := copyRow(r)
				for k := range x {
					x[k] = nil
				}
				if c.plan(table, conflict, x) != p {
					t.Fatal("same shape was not reused")
				}
			}
		}
	}
	first := c.plan("works", "", Row{"a": nil, "b": 2})
	second := c.plan("works", "", Row{"a": nil, "c": 2})
	if first == second {
		t.Fatal("equal field counts conflated different keys")
	}
	var bounded insertPlanCache
	for i := 0; i < 300; i++ {
		r := Row{fmt.Sprintf("synthetic_%03d", i): nil}
		p := bounded.plan("works", "", r)
		_, want := referenceInsert("works", r, "")
		if p.query != want {
			t.Fatal("fallback changed SQL")
		}
	}
	if bounded.count != 128 || len(bounded.groups[insertKey{"works", ""}]) != 128 {
		t.Fatal("unbounded plan cache")
	}
}

func TestInsertPlansRetainNoRolledBackValues(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	works := benchmarkWorks(128)
	w.failAfter = 40
	if _, e := w.Batch(ctx, works); e == nil {
		t.Fatal("failure injection lost")
	}
	if w.insertPlans.count == 0 {
		t.Fatal("cache was not exercised")
	}
	w.failAfter = 0
	if _, e := w.Batch(ctx, works); e != nil {
		t.Fatal(e)
	}
	if e := w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
	var n int
	if e := w.DB.QueryRow("SELECT count(*) FROM works").Scan(&n); e != nil || n != 128 {
		t.Fatal(n, e)
	}
}
