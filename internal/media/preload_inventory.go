package media

import (
	"context"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

// Persist file attributes in bounded FULL transactions. This inventory is
// independent of the catalog and may be used before the first gallery scan.
func (c *Cache) saveCoverInventory(ctx context.Context, l *library.Listing, platform string, authors map[string]bool, plan int64) error {
	rows, err := l.DB.QueryContext(ctx, "SELECT key,relative,size,mtime,author FROM entries WHERE platform=? AND kind='file' ORDER BY key", platform)
	if err != nil {
		return err
	}
	defer rows.Close()
	type file struct {
		key, relative, author string
		size, mtime           int64
	}
	batch := []file{}
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		tx, err := c.index.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		stmt, err := tx.PrepareContext(ctx, `INSERT INTO cover_inventory VALUES (?,?,?,?,?,?,?) ON CONFLICT(platform,key) DO UPDATE SET relative=excluded.relative,size=excluded.size,mtime=excluded.mtime,author=excluded.author,plan=excluded.plan`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, f := range batch {
			if _, err = stmt.ExecContext(ctx, platform, f.key, f.relative, f.size, f.mtime, f.author, plan); err != nil {
				return err
			}
		}
		batch = batch[:0]
		return tx.Commit()
	}
	for rows.Next() {
		var f file
		if err = rows.Scan(&f.key, &f.relative, &f.size, &f.mtime, &f.author); err != nil {
			return err
		}
		if len(authors) == 0 || authors[f.author] {
			batch = append(batch, f)
			if len(batch) >= 1024 {
				if err = flush(); err != nil {
					return err
				}
			}
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if err = flush(); err != nil {
		return err
	}
	if len(authors) == 0 {
		_, err = c.index.db.ExecContext(ctx, "DELETE FROM cover_inventory WHERE platform=? AND plan<>?", platform, plan)
	} else {
		for author := range authors {
			if _, err = c.index.db.ExecContext(ctx, "DELETE FROM cover_inventory WHERE platform=? AND author=? AND plan<>?", platform, author, plan); err != nil {
				return err
			}
		}
	}
	return err
}
