package library

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	_ "modernc.org/sqlite"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Entry struct {
	Platform, Key, Relative, Parent, Kind, Author, Work, Name string
	Size, Mtime                                               int64
}

const entryColumns = "platform,key,relative,parent,kind,size,mtime,author,work,name"

type workSignature struct {
	platform, key, value string
	mtime                sql.NullInt64
}

// Listing stores only platform/author membership and completed work signatures.
// Descendant media facts stay in bounded per-work preparation buffers.
type Listing struct {
	DB           *sql.DB
	Entries      atomic.Int64
	Bytes        atomic.Int64
	Transactions atomic.Int64
	WriteNanos   atomic.Int64
	mu           sync.Mutex
	file         string
	signatures   []workSignature
}

func NewListing(root string) (*Listing, error) {
	if e := NoLinks(root); e != nil {
		return nil, e
	}
	if e := os.MkdirAll(root, 0700); e != nil {
		return nil, e
	}
	f, e := os.CreateTemp(root, "go-listing-*.sqlite")
	if e != nil {
		return nil, e
	}
	f.Close()
	u := url.URL{Scheme: "file", Path: "/" + strings.ReplaceAll(f.Name(), "\\", "/")}
	q := u.Query()
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "cache_size(-8192)")
	q.Add("_pragma", "synchronous(OFF)")
	u.RawQuery = q.Encode()
	db, e := sql.Open("sqlite", u.String())
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(4)
	// This disposable listing is never recovered or used as a committed checkpoint.
	// Catalog durability remains FULL; no live database PRAGMA is changed here.
	if _, e = db.Exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=OFF;PRAGMA cache_size=-8192;PRAGMA temp_store=FILE;
 CREATE TABLE entries(platform TEXT NOT NULL,key TEXT NOT NULL,relative TEXT NOT NULL,parent TEXT NOT NULL,kind TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,author TEXT NOT NULL,work TEXT NOT NULL,name TEXT NOT NULL,fingerprint TEXT NOT NULL DEFAULT '',PRIMARY KEY(platform,key)) WITHOUT ROWID;
 CREATE INDEX entries_parent ON entries(platform,parent,key);`); e != nil {
		db.Close()
		return nil, e
	}
	return &Listing{DB: db, file: f.Name()}, nil
}
func (l *Listing) Close() error {
	e := l.DB.Close()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(l.file + suffix)
	}
	return e
}
func (l *Listing) put(ctx context.Context, entries []Entry) error {
	if len(entries) == 0 {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	started := time.Now()
	defer func() { l.WriteNanos.Add(time.Since(started).Nanoseconds()) }()
	tx, e := l.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	s, e := tx.PrepareContext(ctx, "INSERT INTO entries("+entryColumns+") VALUES (?,?,?,?,?,?,?,?,?,?)")
	if e != nil {
		return e
	}
	defer s.Close()
	for _, r := range entries {
		if _, e = s.ExecContext(ctx, r.Platform, r.Key, r.Relative, r.Parent, r.Kind, r.Size, r.Mtime, r.Author, r.Work, r.Name); e != nil {
			return errors.New("FILESYSTEM_DUPLICATE_OR_INVALID_PATH")
		}
	}
	if e = tx.Commit(); e == nil {
		l.Transactions.Add(1)
	}
	return e
}
func (l *Listing) RecordSignature(ctx context.Context, platform, key, value string, mtime ...int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	stamp := sql.NullInt64{}
	if len(mtime) > 0 {
		stamp = sql.NullInt64{Int64: mtime[0], Valid: true}
	}
	l.signatures = append(l.signatures, workSignature{platform: platform, key: key, value: value, mtime: stamp})
	if len(l.signatures) >= 512 {
		return l.flushSignatures(ctx)
	}
	return nil
}
func (l *Listing) flushSignatures(ctx context.Context) error {
	if len(l.signatures) == 0 {
		return nil
	}
	started := time.Now()
	defer func() { l.WriteNanos.Add(time.Since(started).Nanoseconds()) }()
	tx, e := l.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	s, e := tx.PrepareContext(ctx, "UPDATE entries SET fingerprint=?,mtime=coalesce(?,mtime) WHERE platform=? AND key=? AND kind='folder'")
	if e != nil {
		return e
	}
	defer s.Close()
	for _, r := range l.signatures {
		result, e := s.ExecContext(ctx, r.value, r.mtime, r.platform, r.key)
		if e != nil {
			return e
		}
		n, e := result.RowsAffected()
		if e != nil {
			return e
		}
		if n != 1 {
			return errors.New("WORK_MEMBERSHIP_MISSING")
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	l.Transactions.Add(1)
	l.signatures = l.signatures[:0]
	return nil
}
func scanEntry(rows *sql.Rows) (Entry, error) {
	var r Entry
	e := rows.Scan(&r.Platform, &r.Key, &r.Relative, &r.Parent, &r.Kind, &r.Size, &r.Mtime, &r.Author, &r.Work, &r.Name)
	return r, e
}
func (l *Listing) Page(ctx context.Context, platform, parent, after string) ([]Entry, error) {
	rows, e := l.DB.QueryContext(ctx, "SELECT "+entryColumns+" FROM entries INDEXED BY entries_parent WHERE platform=? AND parent=? AND kind='folder' AND key>? ORDER BY key LIMIT 64", platform, parent, after)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	a := []Entry{}
	for rows.Next() {
		r, e := scanEntry(rows)
		if e != nil {
			return nil, e
		}
		a = append(a, r)
	}
	return a, rows.Err()
}
func (l *Listing) AuthorSignature(ctx context.Context, platform, key string) (string, error) {
	// A domain change prevents reuse of older provider-dependent author ledgers.
	// Every work signature covers all its descendant facts, independent of finish order.
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := l.flushSignatures(ctx); e != nil {
		return "", e
	}
	rows, e := l.DB.QueryContext(ctx, "SELECT key,relative,kind,size,mtime,fingerprint FROM entries WHERE platform=? AND key=? UNION ALL SELECT key,relative,kind,size,mtime,fingerprint FROM entries INDEXED BY entries_parent WHERE platform=? AND parent=? ORDER BY key", platform, key, platform, key)
	if e != nil {
		return "", e
	}
	defer rows.Close()
	h := sha256.New()
	fmt.Fprintln(h, "native-author-v2")
	for rows.Next() {
		var k, r, kind, signature string
		var size, mtime int64
		if e = rows.Scan(&k, &r, &kind, &size, &mtime, &signature); e != nil {
			return "", e
		}
		fmt.Fprintln(h, metadata.JSON([]any{k, r, kind, strconv.FormatInt(size, 10), strconv.FormatInt(mtime, 10), signature}))
	}
	return hex.EncodeToString(h.Sum(nil)), rows.Err()
}
func (l *Listing) Contains(ctx context.Context, platform, key string) (bool, error) {
	var n int
	e := l.DB.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE platform=? AND key=? AND kind='folder')", platform, key).Scan(&n)
	return n == 1, e
}

// Membership batches deletion reconciliation; native absence confirmation stays mandatory.
func (l *Listing) Membership(ctx context.Context, platform string, keys []string) (map[string]bool, error) {
	found := map[string]bool{}
	for start := 0; start < len(keys); start += 256 {
		end := start + 256
		if end > len(keys) {
			end = len(keys)
		}
		args := []any{platform}
		marks := []string{}
		for _, key := range keys[start:end] {
			args = append(args, key)
			marks = append(marks, "?")
		}
		rows, e := l.DB.QueryContext(ctx, "SELECT key FROM entries WHERE platform=? AND kind='folder' AND key IN ("+strings.Join(marks, ",")+")", args...)
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var key string
			if e = rows.Scan(&key); e != nil {
				rows.Close()
				return nil, e
			}
			found[key] = true
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
	}
	return found, nil
}
func Signature(entries []Entry) string {
	h := sha256.New()
	for _, r := range entries {
		fmt.Fprintln(h, metadata.JSON([]any{r.Key, r.Relative, r.Kind, strconv.FormatInt(r.Size, 10), strconv.FormatInt(r.Mtime, 10)}))
	}
	return hex.EncodeToString(h.Sum(nil))
}
