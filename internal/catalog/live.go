package catalog

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
)

type LiveState struct {
	SchemaVersion     int              `json:"schemaVersion"`
	BaseGenerationID  *string          `json:"baseGenerationId"`
	Epoch             string           `json:"epoch"`
	Revision          int64            `json:"revision"`
	InitializedAtMS   int64            `json:"initializedAtMs"`
	PlatformRevisions map[string]int64 `json:"platformRevisions"`
}

var epochPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var generationPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func ReadLiveState(ctx context.Context, db *sql.DB) (LiveState, error) {
	var state LiveState
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return state, err
	}
	defer tx.Rollback()
	state, err = readLiveState(ctx, tx)
	if err != nil {
		return state, err
	}
	return state, tx.Commit()
}

func readLiveState(ctx context.Context, tx *sql.Tx) (LiveState, error) {
	var state LiveState
	def, err := api.LoadCatalog()
	if err != nil {
		return state, err
	}
	err = tx.QueryRowContext(ctx, "SELECT schema_version,base_generation_id,epoch,revision,initialized_at_ms FROM live_meta WHERE singleton=1").Scan(&state.SchemaVersion, &state.BaseGenerationID, &state.Epoch, &state.Revision, &state.InitializedAtMS)
	if err != nil {
		return state, fmt.Errorf("LIVE_META_MISSING: %w", err)
	}
	if state.SchemaVersion != def.LiveSchemaVersion {
		return state, fmt.Errorf("LIVE_SCHEMA_UNSUPPORTED")
	}
	if (state.BaseGenerationID != nil && !generationPattern.MatchString(*state.BaseGenerationID)) || !epochPattern.MatchString(state.Epoch) || !safeNonnegative(state.Revision) || !safeNonnegative(state.InitializedAtMS) {
		return state, fmt.Errorf("LIVE_META_INVALID")
	}
	rows, err := tx.QueryContext(ctx, "SELECT platform_id,last_revision FROM live_platform_stats ORDER BY platform_id")
	if err != nil {
		return state, err
	}
	defer rows.Close()
	state.PlatformRevisions = map[string]int64{}
	for rows.Next() {
		var id string
		var revision int64
		if err = rows.Scan(&id, &revision); err != nil {
			return state, err
		}
		if revision < 0 || revision > state.Revision {
			return state, fmt.Errorf("LIVE_META_INVALID")
		}
		state.PlatformRevisions[id] = revision
	}
	return state, rows.Err()
}

func safeNonnegative(value int64) bool { return value >= 0 && value <= 9007199254740991 }

// UpgradeLive runs only while its caller owns the instance maintenance lock and
// has excluded other runtime/scan owners. No committed facts or IDs are reset.
func UpgradeLive(ctx context.Context, db *sql.DB, sources map[string]string) (bool, error) {
	if err := VerifyContract(ctx, db, ContractOptions{Live: true, LegacyLive: true, Sources: sources}); err != nil {
		return false, err
	}
	var version int
	if err := db.QueryRowContext(ctx, "SELECT schema_version FROM live_meta WHERE singleton=1").Scan(&version); err != nil {
		return false, fmt.Errorf("LIVE_META_INVALID: %w", err)
	}
	def, err := api.LoadCatalog()
	if err != nil {
		return false, err
	}
	if version == def.LiveSchemaVersion {
		return false, nil
	}
	if version != 1 && version != 2 {
		return false, fmt.Errorf("LIVE_SCHEMA_UNSUPPORTED")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if version == 1 {
		if _, err = tx.ExecContext(ctx, api.LiveStatsSQL); err != nil {
			return false, err
		}
		if err = rebuildStats(ctx, tx); err != nil {
			return false, err
		}
	}
	if _, err = tx.ExecContext(ctx, "ALTER TABLE live_meta RENAME TO live_meta_previous;"+strings.Split(api.LiveCoreSQL, ";")[0]+"; INSERT INTO live_meta SELECT * FROM live_meta_previous; DROP TABLE live_meta_previous;"); err != nil {
		return false, err
	}
	if _, err = tx.ExecContext(ctx, api.LiveLedgerSQL); err != nil {
		return false, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE live_meta SET schema_version=? WHERE singleton=1", def.LiveSchemaVersion); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func rebuildStats(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM live_stats; DELETE FROM live_metadata_stats; DELETE FROM live_platform_stats;
INSERT INTO live_stats SELECT 1,(SELECT count(*) FROM works),(SELECT count(*) FROM media),(SELECT count(*) FROM authors);
INSERT INTO live_metadata_stats SELECT metadata_state,count(*) FROM works GROUP BY metadata_state;
INSERT INTO live_platform_stats SELECT p.platform_id,count(w.work_id),coalesce(sum(w.media_count),0),(SELECT revision FROM live_meta WHERE singleton=1) FROM platforms p LEFT JOIN works w ON w.platform_id=p.platform_id GROUP BY p.platform_id;`)
	return err
}
