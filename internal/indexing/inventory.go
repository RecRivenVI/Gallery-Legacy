package indexing

import (
	"context"
	"database/sql"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

// Compare the committed file rows, not directory timestamps or digest values.
// The work transaction owns these rows, so interruption cannot advance an
// uncommitted work's inventory.
func sameFiles(ctx context.Context, read *sql.DB, platform, key string, each func(func(library.Entry) error) error) (bool, error) {
	rows, err := read.QueryContext(ctx, `SELECT f.key,f.relative,f.size,f.mtime FROM live_scan_files f JOIN works w USING(work_id) WHERE w.platform_id=? AND w.relative_path_key=? ORDER BY f.key`, platform, key)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	same, count := true, 0
	err = each(func(e library.Entry) error {
		if e.Kind != "file" {
			return nil
		}
		count++
		if !rows.Next() {
			same = false
			return rows.Err()
		}
		var k, r string
		var size, mtime int64
		if err := rows.Scan(&k, &r, &size, &mtime); err != nil {
			return err
		}
		if k != e.Key || r != e.Relative || size != e.Size || mtime/100 != e.Mtime/100 {
			same = false
		}
		return nil
	})
	if err != nil {
		return false, err
	}
	if rows.Next() {
		same = false
	}
	return same, rows.Err()
}
