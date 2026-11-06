package catalog

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

func TestMetadataUpgradePreservesUnopenedMediaAndResumes(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	sources := map[string]string{}
	rows, err := w.DB.Query("SELECT platform_id,physical_root FROM platforms")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, root string
		if err = rows.Scan(&id, &root); err != nil {
			t.Fatal(err)
		}
		sources[id] = root
	}
	rows.Close()
	relative := `700\2026-01-01_00-00-00_1`
	directory := filepath.Join(sources["pixiv"], filepath.FromSlash(strings.ReplaceAll(relative, `\`, "/")))
	if err = os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"id":"1","title":"新的标题","type":"manga","x_restrict":2,"user":{"id":"700","name":"合成作者"},"caption":"<p>正文</p>"}`)
	file := filepath.Join(directory, "metadata.json")
	if err = os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(file)
	r, _ := metadata.Parse("pixiv", "700", "2026-01-01_00-00-00_1", []byte(`{"id":"1","title":"旧标题","user":{"id":"700"}}`))
	p := Fill("pixiv", "700", "2026-01-01_00-00-00_1", relative, 1, "valid", info.ModTime().UnixNano(), info.Size(), r, "", "go1-a3:raw", []File{{Relative: "absent.png", Key: "absent.png", Name: "absent.png", Extension: ".png", Kind: "image", Size: 99, Mtime: 1}})
	if _, err = w.BatchWithAuthors(ctx, []PreparedWork{p}, []AuthorEnd{{p.Platform, p.AuthorKey, "fingerprint", true}}); err != nil {
		t.Fatal(err)
	}
	var mediaID int64
	w.DB.QueryRow("SELECT media_id FROM media").Scan(&mediaID)
	if _, err = w.DB.Exec("DELETE FROM work_details; UPDATE works SET adapter_version=1"); err != nil {
		t.Fatal(err)
	}
	reads := 0
	read := func(root, path string, limit int64) ([]byte, os.FileInfo, error) {
		reads++
		if filepath.Base(path) != "metadata.json" {
			t.Fatal("opened media", path)
		}
		return library.ReadSource(root, path, limit)
	}
	n, err := w.reparseMetadata(ctx, sources, read)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || reads != 1 {
		t.Fatal("not a metadata-only upgrade", n, reads)
	}
	var gotID, count, rating int64
	var title string
	if err = w.DB.QueryRow("SELECT m.media_id,w.media_count,w.title,d.rating FROM works w JOIN media m USING(work_id) JOIN work_details d USING(work_id)").Scan(&gotID, &count, &title, &rating); err != nil {
		t.Fatal(err)
	}
	if gotID != mediaID || count != 1 || title != "新的标题" || rating != 2 {
		t.Fatal("lost physical facts or enrichment", gotID, count, title, rating)
	}
	reads = 0
	n, err = w.reparseMetadata(ctx, sources, read)
	if err != nil || n != 0 || reads != 0 {
		t.Fatal("upgrade reread completed works", n, reads, err)
	}
	if err = w.Verify(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestLiveFourUpgradesWithoutChangingCatalogFacts(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	if _, err := w.DB.Exec("DROP TABLE work_details; DROP TABLE author_keys; UPDATE live_meta SET schema_version=4"); err != nil {
		t.Fatal(err)
	}
	changed, err := UpgradeLive(ctx, w.DB, nil)
	if err != nil || !changed {
		t.Fatal(changed, err)
	}
	def, _ := api.LoadCatalog()
	var version int
	w.DB.QueryRow("SELECT schema_version FROM live_meta").Scan(&version)
	if version != def.LiveSchemaVersion {
		t.Fatal(version)
	}
	if err = VerifyContract(ctx, w.DB, ContractOptions{Live: true}); err != nil {
		t.Fatal(err)
	}
}

func TestInventoryUpgradeRetiresDeclaredMediaWithoutRemovingFiles(t *testing.T) {
	w := testWriter(t)
	ctx := context.Background()
	r := metadata.New()
	p := Fill("pixiv", "700", "work", `700\work`, 10, "valid", nil, nil, r, "", "old", []File{{Relative: "1.png", Key: "1.png", Name: "1.png", Extension: ".png", Kind: "image", Size: 123, Mtime: 10}})
	if _, err := w.Batch(ctx, []PreparedWork{p}); err != nil {
		t.Fatal(err)
	}
	_, err := w.DB.Exec(`INSERT INTO media_declarations(work_id,ordinal,declared_name,match_state) SELECT work_id,0,'missing.png','unmatched' FROM works;
UPDATE media SET metadata_name='declared.png',declared_size=999,duration_ms=999;
DROP TABLE live_scan_files; UPDATE live_meta SET schema_version=5;`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = UpgradeLive(ctx, w.DB, nil); err != nil {
		t.Fatal(err)
	}
	var declarations, files, retired int
	if err = w.DB.QueryRow(`SELECT (SELECT count(*) FROM media_declarations),(SELECT count(*) FROM media),(SELECT count(*) FROM media WHERE metadata_name IS NOT NULL OR declared_size IS NOT NULL OR duration_ms IS NOT NULL)`).Scan(&declarations, &files, &retired); err != nil {
		t.Fatal(err)
	}
	if declarations != 0 || files != 1 || retired != 0 {
		t.Fatal("upgrade confused declared and physical media", declarations, files, retired)
	}
}
