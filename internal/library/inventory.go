package library

import (
	"context"
	"errors"
	"strings"
)

// Reset is used only before platform dispatch, when an unqualified HTTP
// inventory must be discarded in favor of native traversal.
func (l *Listing) Reset(ctx context.Context, platform string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	r, err := l.DB.ExecContext(ctx, "DELETE FROM entries WHERE platform=?", platform)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	l.Entries.Add(-n)
	l.observations.Delete(platform)
	l.indexed.Delete(platform)
	return err
}

func (l *Listing) Indexed(platform string) bool { _, ok := l.indexed.Load(platform); return ok }

func (l *Listing) EachWorkFile(ctx context.Context, platform, key string, accept func(Entry) error) error {
	rows, err := l.DB.QueryContext(ctx, "SELECT "+entryColumns+" FROM entries WHERE platform=? AND key>? AND key<? AND kind='file' ORDER BY key", platform, key+`\`, key+`]`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return err
		}
		if err = accept(e); err != nil {
			return err
		}
	}
	return rows.Err()
}
func (l *Listing) RememberDirectory(platform, relative string, d Directory) {
	l.mu.Lock()
	defer l.mu.Unlock()
	value, _ := l.observations.LoadOrStore(platform, map[string]Directory{})
	value.(map[string]Directory)[strings.ToLower(relative)] = d
}

func (l *Listing) Observation(platform, key string) (Directory, bool) {
	value, ok := l.observations.Load(platform)
	if !ok {
		return Directory{}, false
	}
	d, ok := value.(map[string]Directory)[strings.ToLower(key)]
	return d, ok
}

// HTTP cannot prove completeness or identify reparse points. Root/author
// membership is cross-checked natively. A first or changed work is still
// verified by native traversal; only a previously verified identical full
// signature can bypass all work I/O. An excluded descendant can never qualify
// reuse because it is present in that committed native file inventory.
func (l *Listing) LoadEverything(ctx context.Context, provider *Everything, platform, root string) (int64, error) {
	buffer := make([]Entry, 0, 2048)
	flush := func() error { err := l.PutNative(ctx, buffer); buffer = buffer[:0]; return err }
	n, err := provider.Read(ctx, root, func(e Entry) error {
		e.Platform = platform
		buffer = append(buffer, e)
		if len(buffer) == cap(buffer) {
			return flush()
		}
		return nil
	})
	if err != nil {
		return n, err
	}
	if err = flush(); err != nil {
		return n, err
	}
	var orphan int
	err = l.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM entries child LEFT JOIN entries parent ON parent.platform=child.platform AND parent.key=child.parent AND parent.kind='folder' WHERE child.platform=? AND child.parent<>'.' AND parent.key IS NULL)`, platform).Scan(&orphan)
	if err != nil {
		return n, err
	}
	if orphan != 0 {
		return n, errors.New("EVERYTHING_PARENT_MISSING")
	}
	observed := map[string]Directory{}
	verify := func(relative string) error {
		count := int64(0)
		d, err := ReadDirectory(ctx, platform, root, relative, func(batch []Entry) error {
			if err := l.matchEntries(ctx, platform, batch); err != nil {
				return err
			}
			count += int64(len(batch))
			return nil
		})
		if err != nil {
			return err
		}
		var indexed int64
		if err = l.DB.QueryRowContext(ctx, "SELECT count(*) FROM entries WHERE platform=? AND parent=?", platform, strings.ToLower(relative)).Scan(&indexed); err != nil {
			return err
		}
		if count != indexed {
			return errors.New("EVERYTHING_MEMBERSHIP_MISMATCH")
		}
		observed[strings.ToLower(relative)] = d
		return nil
	}
	if err = verify("."); err != nil {
		return n, err
	}
	for after := ""; ; {
		authors, err := l.Page(ctx, platform, ".", after)
		if err != nil {
			return n, err
		}
		if len(authors) == 0 {
			break
		}
		for _, a := range authors {
			if err = verify(a.Relative); err != nil {
				return n, err
			}
		}
		after = authors[len(authors)-1].Key
	}
	if err = l.RefreshDirectory(ctx, platform, ".", observed["."]); err != nil {
		return n, err
	}
	l.observations.Store(platform, observed)
	l.indexed.Store(platform, true)
	return n, nil
}

func (l *Listing) matchEntries(ctx context.Context, platform string, batch []Entry) error {
	if len(batch) == 0 {
		return nil
	}
	args := []any{platform}
	marks := make([]string, len(batch))
	for i, r := range batch {
		args = append(args, r.Key)
		marks[i] = "?"
	}
	rows, err := l.DB.QueryContext(ctx, "SELECT "+entryColumns+" FROM entries WHERE platform=? AND key IN ("+strings.Join(marks, ",")+")", args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	indexed := map[string]Entry{}
	for rows.Next() {
		r, err := scanEntry(rows)
		if err != nil {
			return err
		}
		indexed[r.Key] = r
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, actual := range batch {
		r, ok := indexed[actual.Key]
		if !ok || r.Kind != actual.Kind || r.Relative != actual.Relative || r.Size != actual.Size || actual.Kind == "file" && r.Mtime/100 != actual.Mtime/100 {
			return errors.New("EVERYTHING_MEMBERSHIP_MISMATCH")
		}
	}
	return nil
}
