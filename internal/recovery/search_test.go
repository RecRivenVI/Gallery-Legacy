package recovery_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
	"github.com/RecRivenVI/Gallery-Legacy/internal/recovery"
)

func TestImmutableAndLiveUseTheSameSearchAndKeepDetails(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	run := filepath.Join(root, "instance")
	def, _ := api.LoadCatalog()
	sources := map[string]string{}
	for _, p := range def.Platforms {
		sources[p.ID] = filepath.Join(root, "sources", p.ID)
	}
	if err := catalog.CreateLive(ctx, run, sources); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(run, "live/catalog.sqlite")
	w, err := catalog.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	var prepared []catalog.PreparedWork
	for i, raw := range []string{`{"id":"1","title":"风景 simple rain","type":"manga","x_restrict":2,"tags":["a"],"user":{"id":"700","name":"合成作者"}}`, `{"id":"2","title":"城市 city","tags":["b"]}`, `{"id":"3","title":"山水 scene","tags":["a"]}`} {
		name := []string{"one", "two", "three"}[i]
		r, _ := metadata.Parse("pixiv", "700", name, []byte(raw))
		p := catalog.Fill("pixiv", "700", name, `700\`+name, 1790000000000000000, "valid", nil, nil, r, "", "signature-"+name, []catalog.File{{Relative: "1.png", Key: "1.png", Name: "1.png", Extension: ".png", Kind: "image", Size: 12, Mtime: 1790000000000000000}})
		prepared = append(prepared, p)
	}
	if _, err = w.BatchWithAuthors(ctx, prepared, []catalog.AuthorEnd{{Platform: "pixiv", Key: "700", Fingerprint: "author", Complete: true}}); err != nil {
		t.Fatal(err)
	}
	if err = w.Verify(ctx); err != nil {
		t.Fatal(err)
	}
	w.Close()
	config := filepath.Join(run, "config.json")
	raw, _ := json.Marshal(map[string]any{"instanceRoot": run, "sources": sources, "liveUpdates": true, "port": 18499})
	if err = os.WriteFile(config, raw, 0600); err != nil {
		t.Fatal(err)
	}
	c, err := instance.Load(config)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(c.GenerationsRoot, 0700); err != nil {
		t.Fatal(err)
	}
	live, err := reading.Open(ctx, file, "parity", true)
	if err != nil {
		t.Fatal(err)
	}
	queries := []string{"platform=pixiv&q=风&hideEmpty=1", "platform=pixiv&q=rain", "platform=pixiv&q=合成", "platform=pixiv&tag=a", "platform=pixiv&hideEmpty=1"}
	read := func(reader *reading.Reader, q string) map[string]any {
		t.Helper()
		params, _ := url.ParseQuery(q)
		value, err := reader.Snapshot(ctx, func(v *reading.View) (any, error) { return v.Page("works", params, nil) })
		if err != nil {
			t.Fatal(q, err)
		}
		row := value.(map[string]any)
		delete(row, "revision")
		return row
	}
	want := make([]map[string]any, len(queries))
	for i, q := range queries {
		want[i] = read(live, q)
	}
	live.Close()
	g, err := recovery.Build(ctx, c, "parity", file)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := reading.OpenStatic(ctx, g.CatalogPath, g.SearchPath, "parity")
	if err != nil {
		t.Fatal(err)
	}
	for i, q := range queries {
		if got := read(baseline, q); !reflect.DeepEqual(got, want[i]) {
			t.Fatalf("static/live differ for %s", q)
		}
	}
	baseline.Close()
	// An old immutable search file has no readable-content projection. Adapt
	// only a writable test copy; the real immutable checkpoint is untouched.
	legacy := filepath.Join(root, "legacy-search.sqlite")
	bytes, err := os.ReadFile(g.SearchPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(legacy, bytes, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("ALTER TABLE work_sort DROP COLUMN has_readable"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	old, err := reading.OpenStatic(ctx, g.CatalogPath, legacy, "parity")
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	for i, q := range queries {
		if got := read(old, q); !reflect.DeepEqual(got, want[i]) {
			t.Fatalf("legacy static/live differ for %s", q)
		}
	}
}
