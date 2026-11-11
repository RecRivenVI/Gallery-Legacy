package library

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

func (l *Listing) MarkIndexed(platform string) {
	l.indexed.Store(platform, true)
}

func (l *Listing) LoadFileTable(ctx context.Context, instance, platform, root, author string, positions bool) (n int64, result error) {
	path := filepath.Join(instance, "state", "ntfs-inventory.sqlite")
	if err := NoLinks(path); err != nil {
		return 0, err
	}
	started := time.Now()
	defer func() { l.WriteNanos.Add(time.Since(started).Nanoseconds()) }()
	conn, err := l.DB.Conn(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(path), RawQuery: "mode=ro"}
	if _, err = conn.ExecContext(ctx, "ATTACH DATABASE ? AS ntfs", u.String()); err != nil {
		return 0, err
	}
	defer func() {
		_, err := conn.ExecContext(context.WithoutCancel(ctx), "DETACH DATABASE ntfs")
		result = errors.Join(result, err)
	}()
	author = strings.ToLower(author)
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.ExecContext(ctx, `
WITH paths AS (
 SELECT f.*,coalesce(d.key,'') AS parent_key,
        instr(f.key,char(92)) AS first_sep,coalesce(length(d.key)+2,1) AS basename_at
 FROM ntfs.facts f
 JOIN ntfs.scope s USING(platform,author)
 LEFT JOIN ntfs.facts d ON d.platform=f.platform AND d.author=f.author AND d.is_dir=1 AND d.ref=f.parent
 WHERE f.platform=? AND f.author=? AND s.root_path=?
), depths AS (
 SELECT *,instr(substr(key,first_sep+1),char(92)) AS second_sep FROM paths
)
INSERT INTO entries(`+entryColumns+`)
SELECT platform,key,path,parent_key,CASE WHEN is_dir=1 THEN 'folder' ELSE 'file' END,size,mtime,
 CASE WHEN key='.' THEN '' WHEN first_sep=0 THEN key ELSE substr(key,1,first_sep-1) END,
 CASE WHEN first_sep=0 THEN '' WHEN second_sep=0 THEN key ELSE substr(key,1,first_sep+second_sep-1) END,
 CASE WHEN key='.' THEN '' WHEN parent_key='.' THEN path ELSE substr(path,basename_at) END
FROM depths`, platform, author, strings.ToLower(filepath.Clean(root)))
	if err != nil {
		return 0, fmt.Errorf("load NTFS file facts: %w", err)
	}
	n, err = rows.RowsAffected()
	if err != nil || n == 0 {
		return 0, errors.Join(errors.New("NTFS_SCOPE_MISSING_FROM_CHECKPOINT"), err)
	}
	if positions {
		_, err = tx.ExecContext(ctx, `INSERT INTO physical_metadata
SELECT e.platform,e.work,e.relative,e.size,e.mtime,f.position
FROM entries e JOIN ntfs.facts f ON f.platform=e.platform AND f.key=e.key AND f.author=?
WHERE e.platform=? AND e.kind='file' AND e.key=e.work||char(92)||'metadata.json' AND f.position>=0`, author, platform)
		if err != nil {
			return 0, fmt.Errorf("load NTFS metadata positions: %w", err)
		}
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	l.Entries.Add(n)
	l.Transactions.Add(1)
	l.MarkIndexed(platform)
	return n, nil
}
