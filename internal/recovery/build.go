package recovery

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

// Build copies only the completed private candidate, never an open live dataset.
// The caller holds scan ownership. READY is written only after finalization and
// cross-file binding verification; cancellation never publishes a partial build.
func Build(ctx context.Context, c instance.Config, id, liveFile string) (*Checkpoint, error) {
	root, err := paths(c.InstanceRoot, c.GenerationsRoot, id)
	if err != nil {
		return nil, err
	}
	if err = os.Mkdir(root, 0700); os.IsExist(err) {
		return nil, fmt.Errorf("GENERATION_EXISTS")
	} else if err != nil {
		return nil, err
	}
	for _, d := range []string{"catalog", "search"} {
		if err = os.Mkdir(filepath.Join(root, d), 0700); err != nil {
			return nil, err
		}
	}
	manifest := map[string]any{"manifestVersion": 1, "generationId": id, "state": "BUILDING", "createdAtMs": time.Now().UnixMilli()}
	if err = instance.WriteJSON(filepath.Join(root, "manifest.json"), manifest); err != nil {
		return nil, err
	}
	writer, err := catalog.Open(liveFile)
	if err != nil {
		return nil, err
	}
	file := filepath.Join(root, catalogRelative)
	_, err = writer.DB.ExecContext(ctx, "VACUUM INTO ?", file)
	closeErr := writer.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	db, err := sql.Open("sqlite", file+"?_pragma=foreign_keys(1)&_pragma=synchronous(FULL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	defer db.Close()
	search := filepath.Join(root, searchRelative)
	if _, err = db.ExecContext(ctx, "ATTACH DATABASE ? AS search", search); err != nil {
		return nil, err
	}
	if _, err = db.ExecContext(ctx, "PRAGMA search.synchronous=FULL"); err != nil {
		return nil, err
	}
	// Build the immutable search file using the same normalized live documents.
	searchDB, err := sql.Open("sqlite", search+"?_pragma=synchronous(FULL)")
	if err != nil {
		return nil, err
	}
	if _, err = searchDB.ExecContext(ctx, api.StaticSearchSQL); err != nil {
		searchDB.Close()
		return nil, err
	}
	if err = searchDB.Close(); err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, query := range []string{
		"INSERT INTO search.work_sort SELECT work_id,platform_id,author_id,published_sort,title_key,name_key,has_image,has_video FROM live_work_sort",
		"INSERT INTO search.search_docs SELECT * FROM live_search_docs",
		"INSERT INTO search.work_tags SELECT * FROM live_work_tags",
		"INSERT INTO search.authors SELECT * FROM live_authors",
		"INSERT INTO search.tags SELECT * FROM live_tags",
		"INSERT INTO search.work_fts(work_fts) VALUES('rebuild')",
		"INSERT INTO search.short_fts(rowid,terms) SELECT rowid,terms FROM live_short_fts",
		"DROP TABLE live_work_fts; DROP TABLE live_short_fts;",
		"DROP TABLE live_search_docs; DROP TABLE live_work_sort; DROP TABLE live_work_tags; DROP TABLE live_authors; DROP TABLE live_tags; DROP TABLE live_meta; DROP TABLE live_stats; DROP TABLE live_metadata_stats; DROP TABLE live_platform_stats; DROP TABLE live_scan_works; DROP TABLE live_scan_authors; DROP TABLE live_id_high_water; DROP INDEX IF EXISTS live_idx_relation_target_all",
	} {
		if _, err = tx.ExecContext(ctx, query); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	if _, err = db.ExecContext(ctx, "DETACH DATABASE search"); err != nil {
		return nil, err
	}
	if _, err = db.ExecContext(ctx, "PRAGMA journal_mode=DELETE"); err != nil {
		return nil, err
	}
	facts, err := catalog.Validate(ctx, db, false)
	if err != nil {
		return nil, err
	}
	if err = db.Close(); err != nil {
		return nil, err
	}
	catalogIdentity, err := FileIdentity(ctx, file)
	if err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(search)}
	u.RawQuery = "mode=rw&_pragma=synchronous(FULL)"
	searchDB, err = sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	definition, err := api.LoadCatalog()
	if err != nil {
		searchDB.Close()
		return nil, err
	}
	_, err = searchDB.ExecContext(ctx, "INSERT INTO index_state VALUES(1,?,?,?,?,?,?)", definition.SearchVersion, facts["works"], catalogIdentity.SHA256, catalogIdentity.SizeBytes, catalogIdentity.MtimeMS, time.Now().UnixMilli())
	if err == nil {
		var check string
		err = searchDB.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&check)
		if err == nil && check != "ok" {
			err = fmt.Errorf("SEARCH_INTEGRITY_FAILED")
		}
	}
	if err == nil {
		_, err = searchDB.ExecContext(ctx, "PRAGMA journal_mode=DELETE")
	}
	closeErr = searchDB.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	searchIdentity, err := FileIdentity(ctx, search)
	if err != nil {
		return nil, err
	}
	manifest["catalog"] = map[string]any{"relativePath": catalogRelative, "schemaVersion": definition.SchemaVersion, "sha256": catalogIdentity.SHA256, "sizeBytes": catalogIdentity.SizeBytes, "mtimeMs": catalogIdentity.MtimeMS, "workCount": facts["works"]}
	manifest["search"] = map[string]any{"relativePath": searchRelative, "indexVersion": definition.SearchVersion, "sha256": searchIdentity.SHA256, "sizeBytes": searchIdentity.SizeBytes, "mtimeMs": searchIdentity.MtimeMS, "catalogWorkCount": facts["works"], "catalogSizeBytes": catalogIdentity.SizeBytes, "catalogMtimeMs": catalogIdentity.MtimeMS}
	manifest["finalization"] = map[string]any{"version": 1, "catalog": map[string]any{"journalMode": "delete", "sidecars": false}, "search": map[string]any{"journalMode": "delete", "sidecars": false}}
	manifest["validation"] = map[string]any{"catalog": "passed", "search": "passed", "crossGenerationBinding": "passed"}
	manifest["state"] = "VALIDATED"
	manifest["validatedAtMs"] = time.Now().UnixMilli()
	if err = instance.WriteJSON(filepath.Join(root, "manifest.json"), manifest); err != nil {
		return nil, err
	}
	var expected Manifest
	b, _ := json.Marshal(manifest)
	if err = json.Unmarshal(b, &expected); err != nil {
		return nil, err
	}
	checkpoint := &Checkpoint{GenerationID: id, GenerationRoot: root, CatalogPath: file, SearchPath: search, Manifest: expected}
	if err = checkpoint.validateData(ctx); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	manifest["state"] = "READY"
	manifest["readyAtMs"] = time.Now().UnixMilli()
	if err = instance.WriteJSON(filepath.Join(root, "manifest.json"), manifest); err != nil {
		return nil, err
	}
	return Open(ctx, c.InstanceRoot, c.GenerationsRoot, id)
}

func Publish(c instance.Config, id string) error {
	var previous map[string]any
	bytes, err := os.ReadFile(c.ActiveGenerationPath)
	if err == nil {
		if err = json.Unmarshal(bytes, &previous); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	relative, err := filepath.Rel(c.InstanceRoot, filepath.Join(c.GenerationsRoot, id, "manifest.json"))
	if err != nil {
		return err
	}
	pointer := map[string]any{"pointerVersion": 1, "generationId": id, "manifestPath": filepath.ToSlash(relative), "publishedAtMs": time.Now().UnixMilli()}
	if previous["generationId"] != id {
		if p, ok := previous["generationId"].(string); ok && idPattern.MatchString(p) {
			pointer["previousGenerationId"] = p
		}
	} else if previous["previousGenerationId"] != nil {
		pointer["previousGenerationId"] = previous["previousGenerationId"]
	}
	return instance.WriteJSON(c.ActiveGenerationPath, pointer)
}
