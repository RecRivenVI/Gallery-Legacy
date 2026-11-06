package library

import (
	"context"
	"database/sql"
	"strings"
)

type PositionedEntry struct {
	Entry  Entry
	Offset int64
}
type ScheduledWork struct {
	Work     Entry
	Metadata *Entry
}

func (l *Listing) PrepareScheduleTables(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, err := l.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS physical_metadata(platform TEXT,work_key TEXT,relative TEXT,size INTEGER,mtime INTEGER,position INTEGER,PRIMARY KEY(platform,work_key));
CREATE TABLE IF NOT EXISTS work_schedule(platform TEXT,ordinal INTEGER,key TEXT,PRIMARY KEY(platform,ordinal));`)
	return err
}

func (l *Listing) PutPositions(ctx context.Context, items []PositionedEntry) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	tx, err := l.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	s, err := tx.PrepareContext(ctx, "INSERT INTO physical_metadata VALUES (?,?,?,?,?,?)")
	if err != nil {
		return err
	}
	defer s.Close()
	for _, item := range items {
		e := item.Entry
		work := strings.TrimSuffix(e.Key, `\metadata.json`)
		if _, err = s.ExecContext(ctx, e.Platform, work, e.Relative, e.Size, e.Mtime, item.Offset); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (l *Listing) ClearPositions(ctx context.Context, platform string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, err := l.DB.ExecContext(ctx, "DELETE FROM physical_metadata WHERE platform=?", platform)
	return err
}

func (l *Listing) BuildSchedule(ctx context.Context, platform, author string, physical ...bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	query := `INSERT INTO work_schedule SELECT e.platform,row_number() OVER(ORDER BY CASE WHEN p.position>=0 THEN 0 ELSE 1 END,p.position,e.key),e.key FROM entries e LEFT JOIN physical_metadata p ON p.platform=e.platform AND p.work_key=e.key WHERE e.platform=? AND e.kind='folder' AND e.work=e.key`
	if len(physical) > 0 && !physical[0] {
		query = `INSERT INTO work_schedule SELECT e.platform,row_number() OVER(ORDER BY (SELECT count(*) FROM entries a WHERE a.platform=e.platform AND a.parent=e.parent AND a.kind='folder'),e.parent,e.key),e.key FROM entries e WHERE e.platform=? AND e.kind='folder' AND e.work=e.key`
	}
	args := []any{platform}
	if author != "" {
		query += " AND e.parent=?"
		args = append(args, strings.ToLower(author))
	}
	_, err := l.DB.ExecContext(ctx, query, args...)
	return err
}

func (l *Listing) AuthorWorkCount(ctx context.Context, platform, key string) (int64, error) {
	var count int64
	err := l.DB.QueryRowContext(ctx, "SELECT count(*) FROM entries WHERE platform=? AND parent=? AND kind='folder'", platform, key).Scan(&count)
	return count, err
}

func (l *Listing) ScheduledPage(ctx context.Context, platform string, after int64) ([]ScheduledWork, int64, error) {
	columns := "e." + strings.ReplaceAll(entryColumns, ",", ",e.")
	rows, err := l.DB.QueryContext(ctx, "SELECT s.ordinal,"+columns+",p.relative,p.size,p.mtime FROM work_schedule s JOIN entries e ON e.platform=s.platform AND e.key=s.key LEFT JOIN physical_metadata p ON p.platform=s.platform AND p.work_key=s.key WHERE s.platform=? AND s.ordinal>? ORDER BY s.ordinal LIMIT 64", platform, after)
	if err != nil {
		return nil, after, err
	}
	defer rows.Close()
	var result []ScheduledWork
	for rows.Next() {
		var w Entry
		var meta sql.NullString
		var size, mtime sql.NullInt64
		if err = rows.Scan(&after, &w.Platform, &w.Key, &w.Relative, &w.Parent, &w.Kind, &w.Size, &w.Mtime, &w.Author, &w.Work, &w.Name, &meta, &size, &mtime); err != nil {
			return nil, after, err
		}
		item := ScheduledWork{Work: w}
		if meta.Valid {
			item.Metadata = &Entry{Platform: platform, Relative: meta.String, Key: strings.ToLower(meta.String), Name: "metadata.json", Kind: "file", Size: size.Int64, Mtime: mtime.Int64}
		}
		result = append(result, item)
	}
	return result, after, rows.Err()
}
