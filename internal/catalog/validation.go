package catalog

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/RecRivenVI/Gallery-Legacy/api"
)

// Validate checks persisted facts, without reopening or walking source files.
func Validate(ctx context.Context, db *sql.DB, live bool) (map[string]any, error) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := verifyContract(ctx, tx, ContractOptions{Live: live}); err != nil {
		return nil, err
	}
	if err := validateSQLite(ctx, tx); err != nil {
		return nil, err
	}
	checks, err := api.LoadCatalogChecks()
	if err != nil {
		return nil, err
	}
	for _, check := range checks {
		rows, err := tx.QueryContext(ctx, check.SQL)
		if err != nil {
			return nil, err
		}
		invalid := rows.Next()
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if invalid {
			return nil, fmt.Errorf("%s: %s", check.Code, check.Message)
		}
	}
	counts, err := catalogCounts(ctx, tx)
	if err != nil {
		return nil, err
	}
	return counts, tx.Commit()
}

func validateSQLite(ctx context.Context, db *sql.Tx) error {
	rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	invalid := rows.Next()
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if invalid {
		return fmt.Errorf("runtime_foreign_key_check_failed")
	}
	rows, err = db.QueryContext(ctx, "PRAGMA integrity_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var state string
		if err = rows.Scan(&state); err != nil {
			return err
		}
		if state != "ok" {
			return fmt.Errorf("runtime_integrity_check_failed")
		}
		n++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("runtime_integrity_check_failed")
	}
	return nil
}

func catalogCounts(ctx context.Context, db *sql.Tx) (map[string]any, error) {
	counts := map[string]any{}
	for key, table := range map[string]string{"platforms": "platforms", "authors": "authors", "works": "works", "media": "media", "mediaDeclarations": "media_declarations", "tags": "tags", "relations": "social_relations", "shapes": "metadata_shapes"} {
		var n int64
		if err := db.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
			return nil, err
		}
		if n < 0 || n > 9007199254740991 {
			return nil, fmt.Errorf("runtime_count_out_of_range")
		}
		counts[key] = n
	}
	var unavailable int64
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM authors WHERE profile_state<>'valid'").Scan(&unavailable); err != nil {
		return nil, err
	}
	counts["unavailableProfiles"] = unavailable
	states := map[string]int64{}
	rows, err := db.QueryContext(ctx, "SELECT metadata_state,count(*) FROM works GROUP BY metadata_state ORDER BY metadata_state")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var state string
		var n int64
		if err = rows.Scan(&state, &n); err != nil {
			rows.Close()
			return nil, err
		}
		states[state] = n
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	counts["metadataStates"] = states
	for key, query := range map[string]string{
		"sourceWorkCollisions":   "SELECT count(*),coalesce(sum(entity_count),0) FROM (SELECT count(*) entity_count FROM works WHERE source_work_id IS NOT NULL GROUP BY platform_id,source_work_id HAVING count(*)>1)",
		"sourceAuthorCollisions": "SELECT count(*),coalesce(sum(entity_count),0) FROM (SELECT count(*) entity_count FROM authors WHERE source_author_id IS NOT NULL GROUP BY platform_id,source_author_id HAVING count(*)>1)",
	} {
		var groups, entities int64
		if err = db.QueryRowContext(ctx, query).Scan(&groups, &entities); err != nil {
			return nil, err
		}
		counts[key] = map[string]int64{"groups": groups, "entities": entities}
	}
	return counts, nil
}
