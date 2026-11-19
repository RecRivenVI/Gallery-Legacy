// Package accesslog persists the local access and ban audit independently of the catalog.
package accesslog

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	_ "modernc.org/sqlite"
)

type Row = map[string]any

type History struct {
	Version    int             `json:"version"`
	InstanceID string          `json:"instanceId"`
	Enabled    *bool           `json:"enabled,omitempty"`
	AutoBan    json.RawMessage `json:"autoBan,omitempty"`
	Clients    []Row           `json:"clients"`
	Events     []Row           `json:"events"`
}

type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS access_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL, enabled INTEGER, auto_ban BLOB);
CREATE TABLE IF NOT EXISTS access_clients (id TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS access_events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, at_ms INTEGER NOT NULL, data BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS access_events_time ON access_events(kind, at_ms DESC, seq DESC);
`

func Open(root, id string) (*Store, error) {
	path := filepath.Join(root, "access-history.sqlite")
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := library.NoLinks(path + suffix); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create access data directory: %w", err)
	}
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(path)}
	params := u.Query()
	params.Add("_pragma", "synchronous(FULL)")
	params.Add("_pragma", "busy_timeout(1500)")
	u.RawQuery = params.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, fmt.Errorf("open access history: %w", err)
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err = s.initialize(root, id); err != nil {
		return nil, errors.Join(err, db.Close())
	}
	return s, nil
}

func (s *Store) initialize(root, id string) error {
	if _, err := s.db.Exec("PRAGMA journal_mode=WAL;" + schema); err != nil {
		return fmt.Errorf("prepare access history: %w", err)
	}
	var stored string
	err := s.db.QueryRow("SELECT instance_id FROM access_settings WHERE singleton=1").Scan(&stored)
	if err == nil {
		if stored != id {
			return fmt.Errorf("ACCESS_HISTORY_IDENTITY_INVALID")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read access identity: %w", err)
	}

	history := History{Version: 1, InstanceID: id}
	path := filepath.Join(root, "access-history.json")
	if err = library.NoLinks(path); err != nil {
		return err
	}
	raw, err := instance.ReadSnapshot(path)
	if err == nil {
		previous, parseErr := Parse(raw)
		if parseErr != nil {
			return parseErr
		}
		if previous.InstanceID != id {
			return fmt.Errorf("ACCESS_HISTORY_IDENTITY_INVALID")
		}
		history = previous
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read previous access snapshot: %w", err)
	}
	return s.Save(history, nil, false, false)
}

func Parse(data []byte) (History, error) {
	var history History
	if err := json.Unmarshal(data, &history); err != nil {
		return history, fmt.Errorf("decode access history: %w", err)
	}
	if history.Version != 1 || history.InstanceID == "" {
		return history, fmt.Errorf("ACCESS_HISTORY_IDENTITY_INVALID")
	}
	return history, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Load() (History, error) {
	h := History{Version: 1, Clients: []Row{}}
	var enabled sql.NullBool
	if err := s.db.QueryRow("SELECT instance_id,enabled,auto_ban FROM access_settings WHERE singleton=1").
		Scan(&h.InstanceID, &enabled, (*[]byte)(&h.AutoBan)); err != nil {
		return h, fmt.Errorf("load access settings: %w", err)
	}
	if enabled.Valid {
		h.Enabled = &enabled.Bool
	}
	var err error
	h.Clients, err = s.readRows("SELECT data FROM access_clients ORDER BY id")
	return h, err
}

func (s *Store) Events(kind string, since, page, size int64) ([]Row, bool, error) {
	rows, err := s.readRows("SELECT data FROM access_events WHERE kind=? AND at_ms>=? ORDER BY at_ms DESC,seq DESC LIMIT ? OFFSET ?", kind, since, size+1, (page-1)*size)
	if len(rows) > int(size) {
		return rows[:size], true, err
	}
	return rows, false, err
}

// Requests is for the offline legacy importer, which merges a complete snapshot.
func (s *Store) Requests() ([]Row, error) {
	return s.readRows("SELECT data FROM access_events WHERE kind='request' ORDER BY at_ms,seq")
}

func (s *Store) readRows(query string, args ...any) (_ []Row, result error) {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query access rows: %w", err)
	}
	defer func() { result = errors.Join(result, rows.Close()) }()
	out := []Row{}
	for rows.Next() {
		var data []byte
		var row Row
		if err = rows.Scan(&data); err != nil {
			return nil, fmt.Errorf("read access row: %w", err)
		}
		if err = json.Unmarshal(data, &row); err != nil {
			return nil, fmt.Errorf("decode access row: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Save writes changed clients and pending events together. Replacing requests
// is used for explicit clear and offline import. Ban history is independent.
func (s *Store) Save(h History, bans []Row, replaceClients, replaceRequests bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin access write: %w", err)
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO access_settings VALUES(1,?,?,?)
		ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled, auto_ban=excluded.auto_ban`, h.InstanceID, h.Enabled, []byte(h.AutoBan))
	if err != nil {
		return fmt.Errorf("save access settings: %w", err)
	}
	if replaceClients {
		if _, err = tx.Exec("DELETE FROM access_clients"); err != nil {
			return fmt.Errorf("clear access clients: %w", err)
		}
	}
	if replaceRequests {
		if _, err = tx.Exec("DELETE FROM access_events WHERE kind='request'"); err != nil {
			return fmt.Errorf("clear access requests: %w", err)
		}
	}
	if err = writeRows(tx, `INSERT INTO access_clients VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, h.Clients, func(row Row, data []byte) []any { return []any{row["id"], data} }); err != nil {
		return err
	}
	const insertEvent = "INSERT INTO access_events(kind,at_ms,data) VALUES(?,?,?)"
	for _, group := range []struct {
		kind string
		rows []Row
	}{{"request", h.Events}, {"ban", bans}} {
		if err = writeRows(tx, insertEvent, group.rows, func(row Row, data []byte) []any { return []any{group.kind, row["atMs"], data} }); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit access history: %w", err)
	}
	return nil
}

func writeRows(tx *sql.Tx, query string, rows []Row, args func(Row, []byte) []any) error {
	if len(rows) == 0 {
		return nil
	}
	stmt, err := tx.Prepare(query)
	if err != nil {
		return fmt.Errorf("prepare access write: %w", err)
	}
	defer stmt.Close()
	for _, row := range rows {
		data, err := json.Marshal(row)
		if err != nil {
			return fmt.Errorf("encode access row: %w", err)
		}
		if _, err = stmt.Exec(args(row, data)...); err != nil {
			return fmt.Errorf("write access row: %w", err)
		}
	}
	return nil
}
