package catalog

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

func (w *Writer) EmptyAuthor(ctx context.Context, a Row) error {
	tx, e := w.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	t := transaction{ctx: ctx, tx: tx, stmt: map[string]*sql.Stmt{}, owner: w}
	defer t.close()
	var id int64
	e = t.get("SELECT author_id FROM authors WHERE platform_id=? AND relative_path_key=?", a["platform_id"], a["relative_path_key"]).Scan(&id)
	if e == sql.ErrNoRows {
		id, e = t.id("author")
		if e != nil {
			return e
		}
		a = copyRow(a)
		a["author_id"] = id
		if e = t.insert("authors", a, ""); e != nil {
			return e
		}
		if e = t.exec("UPDATE live_stats SET authors=authors+1"); e != nil {
			return e
		}
		if e = t.exec("UPDATE live_meta SET revision=revision+1"); e != nil {
			return e
		}
		if e = t.exec("UPDATE live_platform_stats SET last_revision=(SELECT revision FROM live_meta) WHERE platform_id=?", a["platform_id"]); e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	if e = refreshAuthor(&t, id); e != nil {
		return e
	}
	return t.commit()
}

// Remove is called only by the sealed-scope reconciler after native ENOENT.
func (w *Writer) Remove(ctx context.Context, id int64) error {
	tx, e := w.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	t := transaction{ctx: ctx, tx: tx, stmt: map[string]*sql.Stmt{}, owner: w}
	defer t.close()
	var platform, state string
	var author, media int64
	var shape sql.NullInt64
	var key string
	if e = t.get("SELECT platform_id,author_id,media_count,metadata_state,metadata_shape_id,relative_path_key FROM works WHERE work_id=?", id).Scan(&platform, &author, &media, &state, &shape, &key); e != nil {
		return e
	}
	rows, e := t.query("SELECT tag_id FROM work_tags WHERE work_id=?", id)
	if e != nil {
		return e
	}
	tags := []int64{}
	for rows.Next() {
		var tag int64
		if e = rows.Scan(&tag); e != nil {
			rows.Close()
			return e
		}
		tags = append(tags, tag)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, table := range []string{"live_work_sort", "live_search_docs", "live_work_tags", "live_work_fts", "live_short_fts"} {
		column := "work_id"
		if strings.HasSuffix(table, "fts") {
			column = "rowid"
		}
		if e = t.exec("DELETE FROM "+table+" WHERE "+column+"=?", id); e != nil {
			return e
		}
	}
	if e = t.exec("DELETE FROM works WHERE work_id=?", id); e != nil {
		return e
	}
	if e = t.exec("DELETE FROM live_scan_works WHERE platform_id=? AND relative_path_key=?", platform, key); e != nil {
		return e
	}
	for _, tag := range tags {
		if e = t.exec("UPDATE tags SET work_count=work_count-1 WHERE tag_id=?", tag); e != nil {
			return e
		}
		if e = refreshTag(&t, tag); e != nil {
			return e
		}
	}
	if shape.Valid {
		if e = t.exec("UPDATE metadata_shapes SET work_count=work_count-1 WHERE metadata_shape_id=?", shape.Int64); e != nil {
			return e
		}
	}
	for _, op := range []struct {
		q    string
		args []any
	}{
		{"UPDATE authors SET work_count=work_count-1 WHERE author_id=?", []any{author}},
		{"UPDATE live_stats SET works=works-1,media=media-?", []any{media}},
		{"UPDATE live_metadata_stats SET count=count-1 WHERE metadata_state=?", []any{state}},
		{"UPDATE live_meta SET revision=revision+1", nil},
		{"UPDATE live_platform_stats SET count_works=count_works-1,count_media=count_media-?,last_revision=(SELECT revision FROM live_meta) WHERE platform_id=?", []any{media, platform}},
	} {
		if e = t.exec(op.q, op.args...); e != nil {
			return e
		}
	}
	if e = refreshAuthor(&t, author); e != nil {
		return e
	}
	return t.commit()
}

// RemoveAuthor requires a sealed listing and a native-confirmed absent directory.
// It refuses an author that still owns any physical work.
func (w *Writer) RemoveAuthor(ctx context.Context, platform, key string) error {
	tx, e := w.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	t := transaction{ctx: ctx, tx: tx, stmt: map[string]*sql.Stmt{}, owner: w}
	defer t.close()
	var id, count int64
	if e = t.get("SELECT author_id,work_count FROM authors WHERE platform_id=? AND relative_path_key=?", platform, key).Scan(&id, &count); e != nil {
		return e
	}
	if count != 0 {
		return errors.New("AUTHOR_STILL_HAS_WORKS")
	}
	for _, op := range []struct {
		q    string
		args []any
	}{
		{"DELETE FROM live_authors WHERE author_id=?", []any{id}},
		{"DELETE FROM authors WHERE author_id=?", []any{id}},
		{"DELETE FROM live_scan_authors WHERE platform_id=? AND relative_path_key=?", []any{platform, key}},
		{"UPDATE live_stats SET authors=authors-1", nil},
		{"UPDATE live_meta SET revision=revision+1", nil},
		{"UPDATE live_platform_stats SET last_revision=(SELECT revision FROM live_meta) WHERE platform_id=?", []any{platform}},
	} {
		if e = t.exec(op.q, op.args...); e != nil {
			return e
		}
	}
	return t.commit()
}
