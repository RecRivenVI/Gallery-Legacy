package physical

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type checkpoint struct {
	serial, root uint64
	cursor       journalCursor
}

func tableStore(ctx context.Context, root string) (*sql.DB, error) {
	path := filepath.Join(root, "state", "ntfs-inventory.sqlite")
	if err := library.NoLinks(path); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(path)}
	u.RawQuery = "_pragma=busy_timeout(5000)&_pragma=synchronous(FULL)&_pragma=foreign_keys(ON)"
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.ExecContext(ctx, `PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS scope(platform TEXT NOT NULL,author TEXT NOT NULL,root_path TEXT NOT NULL,volume TEXT NOT NULL,root_ref INTEGER NOT NULL,journal TEXT NOT NULL,next INTEGER NOT NULL,PRIMARY KEY(platform,author)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS facts(platform TEXT NOT NULL,author TEXT NOT NULL,key TEXT NOT NULL,path TEXT NOT NULL,ref INTEGER NOT NULL,parent INTEGER NOT NULL,is_dir INTEGER NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(platform,author,key),FOREIGN KEY(platform,author) REFERENCES scope(platform,author) ON DELETE CASCADE) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS facts_directory ON facts(platform,author,ref) WHERE is_dir=1;`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("open NTFS inventory checkpoint: %w", err)
	}
	return db, nil
}

func checkpointFor(ctx context.Context, db *sql.DB, scope resolvedScope) (checkpoint, error) {
	var old checkpoint
	var serial, journal string
	var ref int64
	err := db.QueryRowContext(ctx, "SELECT volume,root_ref,journal,next FROM scope WHERE platform=? AND author=? AND root_path=?", scope.Platform, strings.ToLower(scope.Author), strings.ToLower(filepath.Clean(scope.Root))).Scan(&serial, &ref, &journal, &old.cursor.Next)
	if err != nil {
		return old, err
	}
	old.root = uint64(ref)
	old.serial, err = strconv.ParseUint(serial, 10, 64)
	if err == nil {
		old.cursor.ID, err = strconv.ParseUint(journal, 10, 64)
	}
	return old, err
}

func loadSnapshot(ctx context.Context, db *sql.DB, scope resolvedScope, fromPlatform bool) (*tableSnapshot, error) {
	key := strings.ToLower(scope.Author)
	query := "SELECT path,ref,parent,is_dir,size,mtime,position FROM facts WHERE platform=? AND author=?"
	args := []any{scope.Platform, key}
	if fromPlatform {
		query += " AND (key='.' OR key=? OR (key>? AND key<?))"
		args = []any{scope.Platform, "", key, key + `\`, key + "]"}
	}
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	s := newSnapshot(scope.ref)
	for rows.Next() {
		var row TableRow
		var ref, parent int64
		if err = rows.Scan(&row.Relative, &ref, &parent, &row.Directory, &row.Size, &row.Mtime, &row.Position); err != nil {
			return nil, err
		}
		row.Ref, row.Parent = uint64(ref), uint64(parent)
		if err = s.add(row); err != nil {
			return nil, err
		}
	}
	if s.directories[scope.ref] != "." {
		return nil, errors.New("NTFS_CHECKPOINT_SCOPE_MISSING")
	}
	return s, rows.Err()
}

// A checkpoint is a source observation. The catalog's per-work ledger is
// separate and advances only on a complete work commit. A cancelled scan can
// reuse these facts without losing any work that has yet to be committed.
func saveSnapshot(ctx context.Context, db *sql.DB, scope resolvedScope, serial uint64, cursor journalCursor, s *tableSnapshot, delta map[string]TableRow) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	author := strings.ToLower(scope.Author)
	if delta == nil {
		if _, err = tx.ExecContext(ctx, "DELETE FROM scope WHERE platform=? AND author=?", scope.Platform, author); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO scope VALUES(?,?,?,?,?,?,?) ON CONFLICT(platform,author) DO UPDATE SET next=excluded.next", scope.Platform, author, strings.ToLower(filepath.Clean(scope.Root)), strconv.FormatUint(serial, 10), int64(scope.ref), strconv.FormatUint(cursor.ID, 10), cursor.Next); err != nil {
		return err
	}
	if delta == nil {
		delta = s.rows
	}
	put, err := tx.PrepareContext(ctx, "INSERT OR REPLACE INTO facts VALUES(?,?,?,?,?,?,?,?,?,?)")
	if err != nil {
		return err
	}
	defer put.Close()
	drop, err := tx.PrepareContext(ctx, "DELETE FROM facts WHERE platform=? AND author=? AND key=?")
	if err != nil {
		return err
	}
	defer drop.Close()
	for path, row := range delta {
		if row.Relative == "" {
			_, err = drop.ExecContext(ctx, scope.Platform, author, path)
		} else {
			_, err = put.ExecContext(ctx, scope.Platform, author, path, row.Relative, int64(row.Ref), int64(row.Parent), row.Directory, row.Size, row.Mtime, row.Position)
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
