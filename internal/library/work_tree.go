package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/derived"
)

// Small works stay in one bounded buffer. Large works spill observations and
// directory proofs to a private SQLite stage; neither depth nor entry count is
// a reason to omit a physically present media file.
type WorkTree struct {
	Entries           []Entry
	Directories       []Directory
	directoryOrdinals []int64
	DB                *sql.DB
	File              string
	root              string
	cursor            int64
	count             int64
	bytes             int64
}

func NewWorkTree(root string) *WorkTree { return &WorkTree{root: root, cursor: -1} }

func (t *WorkTree) Close() error {
	if t.DB == nil {
		return nil
	}
	err := t.DB.Close()
	t.DB = nil
	if t.File != "" {
		err = errors.Join(err, derived.Remove(t.File))
	}
	return err
}

func (t *WorkTree) Detach() (string, error) {
	if t.DB == nil {
		return "", errors.New("WORK_STAGE_REQUIRED")
	}
	if err := t.DB.Close(); err != nil {
		return "", err
	}
	t.DB = nil
	file := t.File
	t.File = ""
	return file, nil
}

func (t *WorkTree) Spill(ctx context.Context) error {
	if t.DB != nil {
		return nil
	}
	if err := NoLinks(t.root); err != nil {
		return err
	}
	if err := os.MkdirAll(t.root, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(t.root, "large-work-*.sqlite")
	if err != nil {
		return err
	}
	f.Close()
	t.File = f.Name()
	u := "file:/" + strings.ReplaceAll(t.File, `\`, "/") + "?_pragma=cache_size(-4096)&_pragma=synchronous(FULL)"
	t.DB, err = sql.Open("sqlite", u)
	if err != nil {
		return err
	}
	t.DB.SetMaxOpenConns(2)
	_, err = t.DB.ExecContext(ctx, `PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE;
CREATE TABLE tree_entries(ordinal INTEGER PRIMARY KEY,platform TEXT,key TEXT NOT NULL UNIQUE,relative TEXT,parent TEXT,kind TEXT,size INTEGER,mtime INTEGER,author TEXT,work TEXT,name TEXT,proof BLOB);
CREATE INDEX tree_directory ON tree_entries(kind,ordinal);
CREATE TABLE stage_records(collection TEXT,ordinal INTEGER,payload BLOB NOT NULL,PRIMARY KEY(collection,ordinal));
CREATE TABLE stage_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),complete INTEGER NOT NULL);INSERT INTO stage_state VALUES(1,0);`)
	if err != nil {
		return err
	}
	entries := t.Entries
	t.Entries = nil
	t.count = 0
	if err = t.addSQL(ctx, entries); err != nil {
		return err
	}
	for i, d := range t.Directories {
		if err = t.markProof(ctx, d, t.directoryOrdinals[i]); err != nil {
			return err
		}
	}
	t.Directories = nil
	t.directoryOrdinals = nil
	return nil
}

func (t *WorkTree) Add(ctx context.Context, entries []Entry) error {
	for _, e := range entries {
		t.bytes += int64(len(e.Relative) + len(e.Key) + 192)
	}
	if t.DB == nil && (len(t.Entries)+len(entries) > 2048 || t.bytes > 4<<20) {
		if err := t.Spill(ctx); err != nil {
			return err
		}
	}
	if t.DB != nil {
		return t.addSQL(ctx, entries)
	}
	t.Entries = append(t.Entries, entries...)
	t.count += int64(len(entries))
	return nil
}

func (t *WorkTree) addSQL(ctx context.Context, entries []Entry) error {
	tx, err := t.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	s, err := tx.PrepareContext(ctx, "INSERT INTO tree_entries(ordinal,"+entryColumns+") VALUES (?,?,?,?,?,?,?,?,?,?,?)")
	if err != nil {
		return err
	}
	defer s.Close()
	for _, r := range entries {
		if _, err = s.ExecContext(ctx, t.count, r.Platform, r.Key, r.Relative, r.Parent, r.Kind, r.Size, r.Mtime, r.Author, r.Work, r.Name); err != nil {
			return err
		}
		t.count++
	}
	return tx.Commit()
}

func (t *WorkTree) NextDirectory(ctx context.Context) (Entry, bool, error) {
	if t.DB == nil {
		for t.cursor+1 < int64(len(t.Entries)) {
			t.cursor++
			r := t.Entries[t.cursor]
			if r.Kind == "folder" {
				return r, true, nil
			}
		}
		return Entry{}, false, nil
	}
	rows, err := t.DB.QueryContext(ctx, "SELECT ordinal,"+entryColumns+" FROM tree_entries WHERE kind='folder' AND ordinal>? ORDER BY ordinal LIMIT 1", t.cursor)
	if err != nil {
		return Entry{}, false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Entry{}, false, rows.Err()
	}
	var r Entry
	err = rows.Scan(&t.cursor, &r.Platform, &r.Key, &r.Relative, &r.Parent, &r.Kind, &r.Size, &r.Mtime, &r.Author, &r.Work, &r.Name)
	return r, err == nil, err
}

func (t *WorkTree) MarkDirectory(ctx context.Context, d Directory) error {
	if t.DB == nil {
		for i := range t.Entries {
			if strings.EqualFold(t.Entries[i].Relative, d.Path) || strings.HasSuffix(strings.ToLower(d.Path), `\`+t.Entries[i].Key) {
				t.Entries[i].Mtime = d.Info.ModTime().UnixNano()
				break
			}
		}
		t.Directories = append(t.Directories, d)
		t.directoryOrdinals = append(t.directoryOrdinals, t.cursor)
		return nil
	}
	return t.markProof(ctx, d, t.cursor)
}

func (t *WorkTree) markProof(ctx context.Context, d Directory, ordinal int64) error {
	proof, err := json.Marshal(d.Proof)
	if err != nil {
		return err
	}
	// Directory paths are captured from their own open handle. Relative suffix
	// matching is avoided in SQL by using the current directory cursor.
	_, err = t.DB.ExecContext(ctx, "UPDATE tree_entries SET mtime=?,proof=? WHERE ordinal=?", d.Info.ModTime().UnixNano(), proof, ordinal)
	return err
}

func (t *WorkTree) Each(ctx context.Context, accept func(Entry) error) error {
	if t.DB == nil {
		entries := append([]Entry(nil), t.Entries...)
		sort.Slice(entries, func(i, j int) bool { return entries[i].Key < entries[j].Key })
		for _, r := range entries {
			if err := accept(r); err != nil {
				return err
			}
		}
		return ctx.Err()
	}
	rows, err := t.DB.QueryContext(ctx, "SELECT "+entryColumns+" FROM tree_entries ORDER BY key")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		r, err := scanEntry(rows)
		if err != nil {
			return err
		}
		if err = accept(r); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (t *WorkTree) Contains(ctx context.Context, key string) (bool, error) {
	if t.DB == nil {
		for _, e := range t.Entries {
			if e.Key == key {
				return true, nil
			}
		}
		return false, nil
	}
	var n int
	err := t.DB.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM tree_entries WHERE key=?)", key).Scan(&n)
	return n == 1, err
}

func (t *WorkTree) RootMtime(ctx context.Context) (int64, error) {
	if t.DB == nil {
		return t.Entries[0].Mtime, nil
	}
	var stamp int64
	err := t.DB.QueryRowContext(ctx, "SELECT mtime FROM tree_entries WHERE ordinal=0").Scan(&stamp)
	return stamp, err
}

func (t *WorkTree) Verify(ctx context.Context, root string) error {
	if t.DB == nil {
		for _, d := range t.Directories {
			if err := d.VerifyLeaf(); err != nil {
				return err
			}
		}
		return ctx.Err()
	}
	rows, err := t.DB.QueryContext(ctx, "SELECT relative,proof FROM tree_entries WHERE kind='folder'")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var relative string
		var raw []byte
		var proof DirectoryProof
		if err = rows.Scan(&relative, &raw); err != nil {
			return err
		}
		if err = json.Unmarshal(raw, &proof); err != nil {
			return fmt.Errorf("WORK_STAGE_INCOMPLETE: %w", err)
		}
		path, err := Join(root, relative)
		if err != nil {
			return err
		}
		if err = (Directory{Path: filepath.Clean(path), Proof: proof}).VerifyLeaf(); err != nil {
			return err
		}
	}
	return rows.Err()
}
