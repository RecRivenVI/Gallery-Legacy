package library

import (
	"context"
	"strings"
)

// The SQLite frontier bounds memory even for a single very large author.
func (l *Listing) LoadNative(ctx context.Context, platform, root string, measured ...func(DirectoryCosts)) error {
	read := func(relative string) error {
		var costs DirectoryCosts
		d, err := ReadDirectoryMeasured(ctx, platform, root, relative, func(entries []Entry) error { return l.PutNative(ctx, entries) }, &costs)
		for _, observe := range measured {
			observe(costs)
		}
		if err == nil && (relative == "." || !strings.Contains(relative, `\`)) {
			if err = l.RefreshDirectory(ctx, platform, relative, d); err == nil {
				l.RememberDirectory(platform, relative, d)
			}
		}
		return err
	}
	if err := read("."); err != nil {
		return err
	}
	after := ""
	for {
		rows, err := l.DB.QueryContext(ctx, "SELECT key,relative FROM entries WHERE platform=? AND kind='folder' AND key<>'.' AND key>? ORDER BY key LIMIT 128", platform, after)
		if err != nil {
			return err
		}
		type directory struct{ key, relative string }
		dirs := []directory{}
		for rows.Next() {
			var d directory
			if err = rows.Scan(&d.key, &d.relative); err != nil {
				break
			}
			dirs = append(dirs, d)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
		if len(dirs) == 0 {
			return nil
		}
		// Read one directory before moving the cursor, so newly discovered
		// descendants remain ahead of it.
		d := dirs[0]
		if err = read(d.relative); err != nil {
			return err
		}
		after = d.key
	}
}
