package catalog

import (
	"context"
	"database/sql"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"strings"
)

func (w *Writer) EndAuthor(ctx context.Context, platform, key, fingerprint string, complete bool) error {
	_, e := w.BatchWithAuthors(ctx, nil, []AuthorEnd{{platform, key, fingerprint, complete}})
	return e
}
func (w *Writer) endAuthor(t *transaction, p PreparedWork, end AuthorEnd, rev int64) error {
	platform, key, fingerprint := end.Platform, end.Key, end.Fingerprint
	if !p.Qualified && p.Key != "" {
		fingerprint = ""
		if e := t.exec("DELETE FROM live_scan_works WHERE platform_id=? AND relative_path_key=?", platform, p.Key); e != nil {
			return e
		}
	}
	var authorID, workID int64
	var shape sql.NullInt64
	if p.Key == "" {
		if e := t.get("SELECT author_id FROM authors WHERE platform_id=? AND relative_path_key=?", platform, key).Scan(&authorID); e != nil {
			return e
		}
	} else {
		if e := t.get("SELECT author_id,work_id,metadata_shape_id FROM works WHERE platform_id=? AND relative_path_key=?", platform, p.Key).Scan(&authorID, &workID, &shape); e != nil {
			return e
		}
	}
	var e error
	state := "unavailable"
	if p.Work["metadata_state"] == "malformed" || p.Work["metadata_state"] == "non_object" || p.Work["metadata_state"] == "partial" {
		state = "invalid"
	}
	if p.Normalized.Valid {
		state = "valid"
	}
	a := copyRow(p.Author)
	a["author_id"] = authorID
	delete(a, "work_count")
	delete(a, "name_rank")
	a["latest_work_at_ms"] = nil
	a["latest_work_id"] = nil
	a["profile_state"] = state
	a["handle"] = nil
	var profile Row
	if p.Normalized.Valid {
		a["latest_work_at_ms"] = p.Work["sort_at_ms"]
		a["latest_work_id"] = workID
		a["handle"] = p.Normalized.Profile["handle"]
		profile = copyRow(p.Profile)
		profile["author_id"] = authorID
		profile["authority_work_id"] = workID
		if shape.Valid {
			profile["metadata_shape_id"] = shape.Int64
		}
	}
	authorSame, e := rowMatches(t, "authors", "author_id", authorID, a)
	if e != nil {
		return e
	}
	profileSame := false
	if profile != nil {
		profileSame, e = rowMatches(t, "author_profiles", "author_id", authorID, profile)
	} else {
		var exists int
		e = t.get("SELECT EXISTS(SELECT 1 FROM author_profiles WHERE author_id=?)", authorID).Scan(&exists)
		profileSame = exists == 0
	}
	if e != nil {
		return e
	}
	if !authorSame || !profileSame {
		t.visible = true
		if e = t.exec("DELETE FROM author_profiles WHERE author_id=?", authorID); e != nil {
			return e
		}
		if e = t.exec("DELETE FROM author_aliases WHERE author_id=?", authorID); e != nil {
			return e
		}
		if p.Normalized.Valid {
			if e = t.insert("author_profiles", profile, ""); e != nil {
				return e
			}
			for _, pair := range [][2]string{{"display_name", "displayName"}, {"handle", "handle"}} {
				if s := text(p.Normalized.Profile[pair[1]]); s != "" {
					if e = t.insert("author_aliases", Row{"author_id": authorID, "platform_id": platform, "alias_kind": pair[0], "display_value": s, "normalized_value": nil}, ""); e != nil {
						return e
					}
				}
			}
		}
		keys := SortedKeys(a)
		sets := []string{}
		args := []any{}
		for _, k := range keys {
			if k == "author_id" || k == "platform_id" || k == "relative_path_key" {
				continue
			}
			sets = append(sets, k+"=?")
			args = append(args, a[k])
		}
		args = append(args, authorID)
		if e = t.exec("UPDATE authors SET "+strings.Join(sets, ",")+" WHERE author_id=?", args...); e != nil {
			return e
		}
		t.authors[authorID] = true
		if e = t.exec("UPDATE live_platform_stats SET last_revision=? WHERE platform_id=?", rev, platform); e != nil {
			return e
		}
	}
	if e = writeAuthorKeys(t, p, authorID); e != nil {
		return e
	}
	if fingerprint != "" {
		if e = t.exec("INSERT INTO live_scan_authors VALUES (?,?,?) ON CONFLICT(platform_id,relative_path_key) DO UPDATE SET fingerprint=excluded.fingerprint", platform, key, fingerprint); e != nil {
			return e
		}
	} else {
		if e = t.exec("DELETE FROM live_scan_authors WHERE platform_id=? AND relative_path_key=?", platform, key); e != nil {
			return e
		}
	}
	return nil
}

// Compare only the small profile projection, never work bodies or media lists.
func rowMatches(t *transaction, table, primary string, id int64, expected Row) (bool, error) {
	keys := SortedKeys(expected)
	values := make([]any, len(keys))
	destinations := make([]any, len(keys))
	for i := range values {
		destinations[i] = &values[i]
	}
	e := t.get("SELECT "+strings.Join(keys, ",")+" FROM "+table+" WHERE "+primary+"=?", id).Scan(destinations...)
	if e == sql.ErrNoRows {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	for i, k := range keys {
		if metadata.JSON(values[i]) != metadata.JSON(expected[k]) {
			return false, nil
		}
	}
	return true, nil
}
