package catalog

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

func syntheticLarge(t *testing.T, count int) (PreparedWork, PreparedWork) {
	t.Helper()
	ctx := context.Background()
	tree := library.NewWorkTree(t.TempDir())
	t.Cleanup(func() { tree.Close() })
	work := "Synthetic\\1000"
	entries := []library.Entry{{Platform: "pixiv", Key: "synthetic\\1000", Relative: work, Kind: "folder", Mtime: 10}}
	files := make([]File, 0, count)
	for i := 0; i < count; i++ {
		name := fmt.Sprintf("%05d.png", i)
		files = append(files, File{Relative: name, Key: name, Name: name, Extension: ".png", Kind: "image", Size: 9, Mtime: 10})
		entries = append(entries, library.Entry{Platform: "pixiv", Key: "synthetic\\1000\\" + name, Relative: work + "\\" + name, Kind: "file", Name: name, Size: 9, Mtime: 10})
	}
	if err := tree.Add(ctx, entries); err != nil {
		t.Fatal(err)
	}
	r := metadata.New()
	r.Valid = true
	r.Work["title"] = "Synthetic large work"
	normal := Fill("pixiv", "Synthetic", "1000", work, 10, "valid", int64(10), int64(20), r, "", "synthetic", files)
	seed := Fill("pixiv", "Synthetic", "1000", work, 10, "valid", int64(10), int64(20), r, "", "synthetic", nil)
	large, err := PrepareLarge(ctx, tree, seed)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ReleasePrepared(large) })
	return normal, large
}

func TestPreparedBodyBeyond32MiBUsesStageWithoutDroppingText(t *testing.T) {
	ctx := context.Background()
	tree := library.NewWorkTree(t.TempDir())
	defer tree.Close()
	if err := tree.Add(ctx, []library.Entry{{Key: "synthetic\\1000", Relative: "Synthetic\\1000", Kind: "folder"}}); err != nil {
		t.Fatal(err)
	}
	r := metadata.New()
	r.Valid = true
	r.Primary = &metadata.Text{SourceFormat: "plain", SourceText: strings.Repeat("synthetic body ", 2400000)}
	p := Fill("pixiv", "Synthetic", "1000", "Synthetic\\1000", 10, "valid", int64(10), int64(len(r.Primary.SourceText)), r, "", "large-body", nil)
	if p.Bytes <= 32<<20 {
		t.Fatal("fixture below former limit")
	}
	large, err := PrepareLarge(ctx, tree, p)
	if err != nil {
		t.Fatal(err)
	}
	defer ReleasePrepared(large)
	if large.Bytes > 1<<20 || large.Children != nil || large.Normalized.Primary != nil {
		t.Fatal("large body retained in queue")
	}
	body, err := openPrepared(ctx, large)
	if err != nil {
		t.Fatal(err)
	}
	defer body.close()
	n := 0
	if err = body.each(ctx, "work_text", func(row Row) error { n = len(text(row["source_text"])); return nil }); err != nil {
		t.Fatal(err)
	}
	if n != len(r.Primary.SourceText) {
		t.Fatal("staged text truncated", n)
	}
	w := testWriter(t)
	if _, err = w.Batch(ctx, []PreparedWork{large}); err != nil {
		t.Fatal(err)
	}
	if err = w.DB.QueryRow("SELECT length(source_text) FROM work_text").Scan(&n); err != nil || n != len(r.Primary.SourceText) {
		t.Fatal("large body not committed", n, err)
	}
	if err = w.Verify(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestLargeStageMappingMatchesInMemoryAndWorkTransaction(t *testing.T) {
	normal, large := syntheticLarge(t, 2050)
	ctx := context.Background()
	body, err := openPrepared(ctx, large)
	if err != nil {
		t.Fatal(err)
	}
	var media, decl []Row
	if err = body.each(ctx, "media", func(r Row) error { media = append(media, r); return nil }); err != nil {
		t.Fatal(err)
	}
	if err = body.each(ctx, "media_declarations", func(r Row) error { decl = append(decl, r); return nil }); err != nil {
		t.Fatal(err)
	}
	body.close()
	if !reflect.DeepEqual(normal.Media, media) || len(decl) != 0 || !reflect.DeepEqual(normal.Work, large.Work) {
		t.Fatal("stage mapping differs from established mapper")
	}
	w := testWriter(t)
	if _, err = w.Batch(ctx, []PreparedWork{normal}); err != nil {
		t.Fatal(err)
	}
	queries := []string{"SELECT * FROM works ORDER BY work_id", "SELECT * FROM media ORDER BY media_id", "SELECT * FROM media_declarations ORDER BY work_id,ordinal", "SELECT * FROM live_stats"}
	before := make([][]map[string]any, len(queries))
	for i, q := range queries {
		before[i] = schemaRows(t, w.DB, q)
	}
	if _, err = w.Batch(ctx, []PreparedWork{large}); err != nil {
		t.Fatal(err)
	}
	for i, q := range queries {
		if !reflect.DeepEqual(before[i], schemaRows(t, w.DB, q)) {
			t.Fatal("staged transaction changed stable facts", q)
		}
	}
	if err = w.Verify(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestInterruptedLargeStageCannotPublishAndCanBeReprepared(t *testing.T) {
	_, large := syntheticLarge(t, 2050)
	ctx := context.Background()
	w := testWriter(t)
	stage, err := sql.Open("sqlite", large.StageFile)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = stage.Exec("UPDATE stage_state SET complete=0"); err != nil {
		t.Fatal(err)
	}
	stage.Close()
	if _, err = w.Batch(ctx, []PreparedWork{large}); err == nil || err.Error() != "WORK_STAGE_INCOMPLETE" {
		t.Fatal(err)
	}
	var n int
	if err = w.DB.QueryRow("SELECT count(*) FROM works").Scan(&n); err != nil || n != 0 {
		t.Fatal("partial work published", n, err)
	}
	if err = RecoverWorkStages(filepath.Dir(large.StageFile)); err != nil {
		t.Fatal(err)
	}
	_, retry := syntheticLarge(t, 2050)
	if _, err = w.Batch(ctx, []PreparedWork{retry}); err != nil {
		t.Fatal(err)
	}
	if err = w.Verify(ctx); err != nil {
		t.Fatal(err)
	}
}
