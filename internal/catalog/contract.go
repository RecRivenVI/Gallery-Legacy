package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"

	"github.com/RecRivenVI/Gallery-Legacy/api"
)

var ErrSourceBindingMismatch = errors.New("SOURCE_BINDING_MISMATCH")

type ContractOptions struct {
	Live            bool              `json:"allowLive"`
	LegacyLive      bool              `json:"allowLegacyLive"`
	CurrentRegistry bool              `json:"requireCurrentRegistry"`
	Sources         map[string]string `json:"sources"`
}

func VerifyContract(ctx context.Context, db *sql.DB, options ContractOptions) error {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = verifyContract(ctx, tx, options); err != nil {
		return err
	}
	return tx.Commit()
}

func verifyContract(ctx context.Context, db *sql.Tx, options ContractOptions) error {
	var enabled int
	if err := db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&enabled); err != nil {
		return err
	}
	if enabled != 1 {
		return fmt.Errorf("foreign_keys_disabled")
	}
	def, err := api.LoadCatalog()
	if err != nil {
		return err
	}
	fingerprint, err := verifyHeader(ctx, db, def)
	if err != nil {
		return err
	}
	if err = verifyRegistry(ctx, db, def, fingerprint, options); err != nil {
		return err
	}
	var hasLive int
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='live_meta'").Scan(&hasLive); err != nil {
		return err
	}
	if hasLive != 0 && !options.Live {
		return fmt.Errorf("catalog_live_mode_required")
	}
	if options.Live {
		return verifyLiveObjects(ctx, db, options.LegacyLive)
	}
	return nil
}

func verifyHeader(ctx context.Context, db *sql.Tx, def api.Catalog) (string, error) {
	var schema, adapter, shape, authority int
	var normalizer, sanitizer, search sql.NullInt64
	var fingerprint string
	err := db.QueryRowContext(ctx, "SELECT schema_version,adapter_contract_version,shape_signature_version,filesystem_authority_contract_version,normalizer_version,sanitizer_version,search_index_version,platform_registry_fingerprint FROM catalog_state WHERE singleton=1").Scan(&schema, &adapter, &shape, &authority, &normalizer, &sanitizer, &search, &fingerprint)
	if err != nil {
		return "", fmt.Errorf("catalog_contract_mismatch: %w", err)
	}
	if schema != def.SchemaVersion || adapter != def.AdapterContractVersion || shape != def.ShapeSignatureVersion || authority != def.AuthorityContractVersion || normalizer.Valid || sanitizer.Valid || search.Valid {
		return "", fmt.Errorf("catalog_contract_mismatch")
	}
	return fingerprint, nil
}

func verifyRegistry(ctx context.Context, db *sql.Tx, def api.Catalog, fingerprint string, options ContractOptions) error {
	actual, err := storedPlatforms(ctx, db, def)
	if err != nil {
		return err
	}
	roots := map[string]string{}
	for _, p := range actual {
		roots[p.ID] = p.Root
	}
	expected, err := bindings(def, roots)
	if err != nil {
		return fmt.Errorf("catalog_contract_mismatch: %w", err)
	}
	wantFingerprint, err := registryFingerprint(actual)
	if err != nil {
		return err
	}
	if wantFingerprint != fingerprint {
		return fmt.Errorf("catalog_contract_mismatch")
	}
	for i, p := range actual {
		want := expected[i]
		if p.Family != want.Family || p.Root != want.Root || p.Key != want.Key || p.Enabled != want.Enabled {
			return fmt.Errorf("catalog_contract_mismatch")
		}
		if p.Adapter > want.Adapter || p.Shape > want.Shape {
			return fmt.Errorf("catalog_contract_future_version")
		}
		if options.CurrentRegistry && (p.Adapter != want.Adapter || p.Shape != want.Shape) {
			return fmt.Errorf("catalog_contract_stale_version")
		}
		if options.Sources != nil && rootKey(options.Sources[p.ID]) != p.Key {
			return ErrSourceBindingMismatch
		}
	}
	return nil
}

func storedPlatforms(ctx context.Context, db *sql.Tx, def api.Catalog) ([]platformBinding, error) {
	rows, err := db.QueryContext(ctx, "SELECT platform_id,family,physical_root,physical_root_key,enabled,adapter_version,shape_policy_version FROM platforms")
	if err != nil {
		return nil, fmt.Errorf("catalog_contract_mismatch: %w", err)
	}
	defer rows.Close()
	byID := map[string]platformBinding{}
	for rows.Next() {
		var p platformBinding
		var enabled int
		if err = rows.Scan(&p.ID, &p.Family, &p.Root, &p.Key, &enabled, &p.Adapter, &p.Shape); err != nil {
			return nil, err
		}
		p.Enabled = enabled == 1
		byID[p.ID] = p
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(byID) != len(def.Platforms) {
		return nil, fmt.Errorf("catalog_contract_mismatch")
	}
	result := []platformBinding{}
	for _, p := range def.Platforms {
		actual, ok := byID[p.ID]
		if !ok {
			return nil, fmt.Errorf("catalog_contract_mismatch")
		}
		result = append(result, actual)
	}
	return result, nil
}

func verifyLiveObjects(ctx context.Context, db *sql.Tx, legacy bool) error {
	core := []string{"live_meta", "live_id_high_water", "live_work_sort", "live_search_docs", "live_work_tags", "live_work_fts", "live_short_fts", "live_authors", "live_tags"}
	stats := []string{"live_stats", "live_metadata_stats", "live_platform_stats"}
	ledger := []string{"live_scan_works", "live_scan_authors"}
	var version int
	if err := db.QueryRowContext(ctx, "SELECT schema_version FROM live_meta WHERE singleton=1").Scan(&version); err != nil {
		return fmt.Errorf("catalog_live_contract_mismatch: %w", err)
	}
	required := append([]string{}, core...)
	if !legacy {
		required = append(required, stats...)
		if version >= 3 {
			required = append(required, ledger...)
		}
	}
	for _, name := range required {
		var n int
		if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name=?", name).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("catalog_live_contract_mismatch")
		}
	}
	allowed := append(append(append([]string{}, core...), stats...), ledger...)
	for _, base := range []string{"live_work_fts", "live_short_fts"} {
		for _, suffix := range []string{"_data", "_idx", "_content", "_docsize", "_config"} {
			allowed = append(allowed, base+suffix)
		}
	}
	rows, err := db.QueryContext(ctx, "SELECT type,name FROM sqlite_master WHERE (type='table' OR type='trigger') AND name LIKE 'live_%'")
	if err != nil {
		return err
	}
	for rows.Next() {
		var kind, name string
		if err = rows.Scan(&kind, &name); err != nil {
			rows.Close()
			return err
		}
		if kind == "trigger" || !slices.Contains(allowed, name) {
			rows.Close()
			return fmt.Errorf("catalog_live_contract_mismatch")
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var count int
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='live_idx_relation_target_all' AND tbl_name='social_relations'").Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return fmt.Errorf("catalog_live_contract_mismatch")
	}
	return nil
}
