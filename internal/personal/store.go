// Package personal owns local accounts and reading data, independently of the
// scan writer. Stable platform/path keys survive catalog recovery and rescans.
package personal

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	_ "modernc.org/sqlite"
)

type Store struct {
	DB   *sql.DB
	File string
}

func Open(root string) (*Store, error) {
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create personal directory: %w", err)
	}
	file := filepath.Join(root, "personal.sqlite")
	u := url.URL{Scheme: "file", Path: "/" + strings.ReplaceAll(file, "\\", "/")}
	q := u.Query()
	for _, pragma := range []string{"foreign_keys(1)", "busy_timeout(1500)", "synchronous(FULL)"} {
		q.Add("_pragma", pragma)
	}
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, fmt.Errorf("open personal data: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("PRAGMA journal_mode=WAL;" + api.PersonalSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("prepare personal data: %w", err)
	}
	return &Store{DB: db, File: file}, nil
}
func (s *Store) Close() error   { return s.DB.Close() }
func failure(code string) error { return &protocol.Error{Code: code, Status: 400} }
func (s *Store) transaction(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin personal change: %w", err)
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit personal change: %w", err)
	}
	return nil
}
