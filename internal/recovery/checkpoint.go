package recovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

var ErrActiveMissing = errors.New("ACTIVE_GENERATION_MISSING")

type Identity struct {
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
	MtimeMS   int64  `json:"mtimeMs"`
}
type Section struct {
	Identity
	RelativePath     string `json:"relativePath"`
	SchemaVersion    int    `json:"schemaVersion"`
	IndexVersion     int    `json:"indexVersion"`
	WorkCount        int64  `json:"workCount"`
	CatalogWorkCount int64  `json:"catalogWorkCount"`
	CatalogSizeBytes int64  `json:"catalogSizeBytes"`
	CatalogMtimeMS   int64  `json:"catalogMtimeMs"`
}
type FinalizedFile struct {
	JournalMode string `json:"journalMode"`
	Sidecars    *bool  `json:"sidecars"`
}
type Manifest struct {
	invalidCatalogIdentity, invalidSearchIdentity bool
	invalidCatalogBinding, invalidSearchBinding   bool
	Version                                       int     `json:"manifestVersion"`
	GenerationID                                  string  `json:"generationId"`
	State                                         string  `json:"state"`
	Catalog                                       Section `json:"catalog"`
	Search                                        Section `json:"search"`
	Finalization                                  struct {
		Version         int `json:"version"`
		Catalog, Search FinalizedFile
	} `json:"finalization"`
	Validation struct{ Catalog, Search, CrossGenerationBinding string } `json:"validation"`
}
type Checkpoint struct {
	GenerationID   string         `json:"generationId"`
	GenerationRoot string         `json:"generationRoot"`
	CatalogPath    string         `json:"catalogPath"`
	SearchPath     string         `json:"searchIndexPath"`
	Manifest       Manifest       `json:"manifest"`
	Facts          map[string]any `json:"facts"`
}

func manifestShape(manifest Manifest, id string) error {
	def, err := api.LoadCatalog()
	if err != nil {
		return err
	}
	if manifest.Version != 1 {
		return fmt.Errorf("GENERATION_MANIFEST_VERSION_UNSUPPORTED")
	}
	if manifest.GenerationID != id {
		return fmt.Errorf("GENERATION_ID_MISMATCH")
	}
	if manifest.State != "READY" {
		return fmt.Errorf("GENERATION_NOT_READY")
	}
	if manifest.Catalog.RelativePath != catalogRelative || manifest.Search.RelativePath != searchRelative {
		return fmt.Errorf("GENERATION_MANIFEST_PATH_INVALID")
	}
	if manifest.Catalog.SchemaVersion != def.SchemaVersion {
		return fmt.Errorf("GENERATION_CATALOG_SCHEMA_UNSUPPORTED")
	}
	if manifest.Search.IndexVersion != def.SearchVersion {
		return fmt.Errorf("GENERATION_SEARCH_VERSION_UNSUPPORTED")
	}
	final := manifest.Finalization
	if final.Version != 1 || final.Catalog.JournalMode != "delete" || final.Search.JournalMode != "delete" || final.Catalog.Sidecars == nil || *final.Catalog.Sidecars || final.Search.Sidecars == nil || *final.Search.Sidecars {
		return fmt.Errorf("GENERATION_NOT_FINALIZED")
	}
	validation := manifest.Validation
	if validation.Catalog != "passed" || validation.Search != "passed" || validation.CrossGenerationBinding != "passed" {
		return fmt.Errorf("GENERATION_VALIDATION_INCOMPLETE")
	}
	return nil
}

func Open(ctx context.Context, instance, generations, id string) (*Checkpoint, error) {
	root, err := paths(instance, generations, id)
	if err != nil {
		return nil, err
	}
	checkpoint := &Checkpoint{GenerationID: id, GenerationRoot: root, CatalogPath: filepath.Join(root, catalogRelative), SearchPath: filepath.Join(root, searchRelative)}
	if err = readJSON(filepath.Join(root, "manifest.json"), &checkpoint.Manifest); err != nil {
		return nil, err
	}
	if err = manifestShape(checkpoint.Manifest, id); err != nil {
		return nil, err
	}
	for _, file := range []string{checkpoint.CatalogPath, checkpoint.SearchPath} {
		if _, err = os.Stat(file); os.IsNotExist(err) {
			return nil, fmt.Errorf("GENERATION_FILE_MISSING")
		} else if err != nil {
			return nil, err
		}
		for _, suffix := range []string{"-wal", "-shm", "-journal"} {
			if _, err = os.Lstat(file + suffix); err == nil {
				return nil, fmt.Errorf("GENERATION_SQLITE_SIDECAR_PRESENT")
			} else if !os.IsNotExist(err) {
				return nil, err
			}
		}
	}
	if err = checkpoint.validateData(ctx); err != nil {
		return nil, err
	}
	return checkpoint, nil
}

func (c *Checkpoint) validateData(ctx context.Context) error {
	db, err := existingReadOnly(ctx, c.CatalogPath)
	if err != nil {
		return err
	}
	facts, err := catalog.Validate(ctx, db, false)
	if err != nil {
		db.Close()
		return err
	}
	var incomplete int
	err = db.QueryRowContext(ctx, "SELECT count(*) FROM works WHERE filesystem_state<>'present' OR filesystem_files_state<>'complete'").Scan(&incomplete)
	db.Close()
	if err != nil {
		return err
	}
	if incomplete != 0 {
		return fmt.Errorf("GENERATION_FILESYSTEM_INCOMPLETE")
	}
	identity, err := FileIdentity(ctx, c.CatalogPath)
	if err != nil {
		return err
	}
	if err = c.validateSearch(ctx, identity, facts["works"].(int64)); err != nil {
		return err
	}
	search, err := FileIdentity(ctx, c.SearchPath)
	if err != nil {
		return err
	}
	if c.Manifest.invalidCatalogIdentity || c.Manifest.invalidSearchIdentity || identity != c.Manifest.Catalog.Identity || search != c.Manifest.Search.Identity {
		return fmt.Errorf("GENERATION_IDENTITY_MISMATCH")
	}
	m := c.Manifest
	if m.invalidCatalogBinding || m.invalidSearchBinding || m.Catalog.WorkCount != facts["works"] || m.Search.CatalogWorkCount != facts["works"] || m.Search.CatalogSizeBytes != identity.SizeBytes || m.Search.CatalogMtimeMS != identity.MtimeMS {
		return fmt.Errorf("GENERATION_BINDING_MISMATCH")
	}
	c.Facts = facts
	return nil
}

func (c *Checkpoint) validateSearch(ctx context.Context, identity Identity, works int64) error {
	db, err := existingReadOnly(ctx, c.SearchPath)
	if err != nil {
		return err
	}
	defer db.Close()
	var version int
	var count, size, mtime int64
	var sha string
	err = db.QueryRowContext(ctx, "SELECT version,catalog_work_count,catalog_sha256,catalog_size,catalog_mtime_ms FROM index_state WHERE singleton=1").Scan(&version, &count, &sha, &size, &mtime)
	if err != nil {
		return fmt.Errorf("SEARCH_BINDING_MISMATCH: %w", err)
	}
	def, err := api.LoadCatalog()
	if err != nil {
		return err
	}
	if version != def.SearchVersion || count != works || sha != identity.SHA256 || size != identity.SizeBytes || mtime != identity.MtimeMS {
		return fmt.Errorf("SEARCH_BINDING_MISMATCH")
	}
	return nil
}

func Active(ctx context.Context, instance, generations, pointerPath string) (*Checkpoint, error) {
	if pointerPath == "" {
		pointerPath = filepath.Join(instance, "active-generation.json")
	}
	if !filepath.IsAbs(pointerPath) || !library.Inside(instance, pointerPath) || filepath.Clean(instance) == filepath.Clean(pointerPath) {
		return nil, fmt.Errorf("GENERATION_PATH_ESCAPE")
	}
	if _, err := os.Stat(pointerPath); os.IsNotExist(err) {
		return nil, ErrActiveMissing
	} else if err != nil {
		return nil, err
	}
	var pointer map[string]json.RawMessage
	if err := readJSON(pointerPath, &pointer); err != nil {
		return nil, err
	}
	if number(pointer["pointerVersion"]) != 1 {
		return nil, fmt.Errorf("ACTIVE_POINTER_VERSION_UNSUPPORTED")
	}
	id := text(pointer["generationId"])
	root, err := paths(instance, generations, id)
	if err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(instance, filepath.Join(root, "manifest.json"))
	if err != nil {
		return nil, err
	}
	if filepath.ToSlash(relative) != text(pointer["manifestPath"]) {
		return nil, fmt.Errorf("ACTIVE_POINTER_INVALID")
	}
	return Open(ctx, instance, generations, id)
}
