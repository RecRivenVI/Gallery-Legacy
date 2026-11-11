package library

import (
	"context"
	"strings"
)

// Reset is used only before platform dispatch, when an unqualified
// file-table snapshot must be discarded in favor of native traversal.
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
