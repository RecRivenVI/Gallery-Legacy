package reading

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/searchquery"
)

func (v *View) workPage(q protocol.Query, offset int64) (searchResult, error) {
	var result searchResult
	order := workOrders[q.Sort]
	from := v.table("work_sort") + " s"
	if needsCanonical(q) {
		from += " JOIN works w ON w.work_id=s.work_id"
	}
	conditions, args, err := v.workConditions(q)
	if err != nil {
		return result, err
	}
	if q.Sort == "bookmarks_desc" || q.Sort == "views_desc" || q.Sort == "likes_desc" {
		from += " LEFT JOIN work_metrics wm ON wm.work_id=s.work_id"
		order = sortOrder{"coalesce(wm." + strings.TrimSuffix(q.Sort, "_desc") + ",0)", "DESC", "<"}
	} else if q.Sort == "rating_desc" || q.Sort == "favorite_desc" || q.Filters.Get("my") == "history" || q.Filters.Get("my") == "continue" {
		column := "rating"
		if q.Sort == "favorite_desc" {
			column = "favorite_at"
		}
		if q.Filters.Get("my") == "history" || q.Filters.Get("my") == "continue" {
			column = "read_at"
		}
		order = sortOrder{"0", "DESC", "<"}
		if v.personal {
			from += " LEFT JOIN personal.work_state ps ON ps.platform=w.platform_id AND ps.relative_key=w.relative_path_key AND ps.account_id=?"
			args = append([]any{v.accountID}, args...)
			order.column = "coalesce(ps." + column + ",0)"
		}
	} else {
		order.column = "s." + order.column
	}
	total, err := v.count(from, conditions, args)
	if err != nil {
		return result, err
	}
	if q.Cursor != nil {
		conditions = append(conditions, "("+order.column+" "+order.operator+" ? OR ("+order.column+"=? AND s.work_id "+order.operator+" ?))")
		value, err := cursorNumber(q)
		if err != nil {
			return result, err
		}
		args = append(args, value, value, q.Cursor["workId"])
	}
	args = append(args, q.Limit, offset)
	rows, err := v.rows("SELECT s.work_id,"+order.column+" sort_value FROM "+from+where(conditions)+" ORDER BY "+order.column+" "+order.direction+",s.work_id "+order.direction+" LIMIT ? OFFSET ?", args...)
	return searchResult{rows: rows, total: total, mode: "browse", cursor: nextCursor(rows, "workId", "work_id")}, err
}

func (v *View) workConditions(q protocol.Query) ([]string, []any, error) {
	conditions := []string{}
	args := []any{}
	if len(q.Platforms) > 0 {
		raw, _ := json.Marshal(q.Platforms)
		conditions = append(conditions, "s.platform_id IN (SELECT value FROM json_each(?))")
		args = append(args, string(raw))
	} else if q.PlatformID != nil && q.Filters.Get("linkedAuthor") == "" && q.Filters.Get("my") == "" && q.Filters.Get("collection") == "" {
		conditions = append(conditions, "s.platform_id=?")
		args = append(args, *q.PlatformID)
	}
	if q.AuthorID != nil {
		conditions = append(conditions, "s.author_id=?")
		args = append(args, *q.AuthorID)
	}
	if q.MediaType == "image" {
		conditions = append(conditions, "s.has_image=1", "s.has_video=0")
	} else if q.MediaType == "video" {
		conditions = append(conditions, "s.has_video=1")
	}
	if q.HideEmpty {
		conditions = append(conditions, "s.has_readable=1")
	}
	terms := append([]api.SearchTerm{}, q.Terms...)
	if q.Tag != nil {
		terms = append(terms, api.SearchTerm{Field: "tag", Value: *q.Tag})
	}
	for _, pair := range []struct {
		Key, Field string
		Exclude    bool
	}{{"includeTags", "tag", false}, {"excludeTags", "tag", true}, {"myTags", "mytag", false}} {
		for _, value := range protocol.TagList(q.Filters.Get(pair.Key)) {
			if value != "" {
				terms = append(terms, api.SearchTerm{Field: pair.Field, Value: value, Exclude: pair.Exclude})
			}
		}
	}
	plain := 0
	for _, term := range terms {
		if term.Field == "any" && !term.Exclude {
			plain++
		}
	}
	for _, term := range terms {
		if term.Field == "platform" && !term.Exclude {
			continue
		}
		clause, values := v.termCondition(term)
		if plain > 1 && term.Field == "any" {
			value := catalog.NormalizeQuery(term.Value)
			clause = "(instr(s.title_key,?)>0 OR s.work_id IN (SELECT wt.work_id FROM " + v.table("work_tags") + " wt JOIN " + v.table("tags") + " t USING(tag_id) WHERE instr(t.normalized_key,?)>0) OR s.author_id IN (SELECT author_id FROM authors WHERE instr(gallery_normalize(display_name),?)>0))"
			values = []any{value, value, value}
		}
		scope := q.Platforms
		if len(scope) == 0 && q.PlatformID != nil {
			scope = []string{*q.PlatformID}
		}
		if len(scope) > 0 && (term.Field == "id" || term.Field == "uid") {
			raw, _ := json.Marshal(scope)
			if term.Field == "id" {
				clause = "s.work_id IN (SELECT work_id FROM works WHERE platform_id IN(SELECT value FROM json_each(?)) AND source_work_id=?)"
			} else {
				clause = "s.author_id IN (SELECT author_id FROM authors WHERE platform_id IN(SELECT value FROM json_each(?)) AND source_author_id=?)"
			}
			values = []any{string(raw), term.Value}
		}
		if term.Exclude {
			clause = "NOT (" + clause + ")"
		}
		conditions = append(conditions, clause)
		args = append(args, values...)
	}
	more, values, err := v.filterConditions(q)
	if err != nil {
		return nil, nil, err
	}
	conditions = append(conditions, more...)
	args = append(args, values...)
	return conditions, args, nil
}

func (v *View) termCondition(term api.SearchTerm) (string, []any) {
	value := catalog.NormalizeQuery(term.Value)
	switch term.Field {
	case "platform":
		values := []string{}
		for _, p := range strings.Split(term.Value, ",") {
			if id := searchquery.Platform(p); id != "" {
				values = append(values, id)
			}
		}
		raw, _ := json.Marshal(values)
		return "s.platform_id IN (SELECT value FROM json_each(?))", []any{string(raw)}
	case "id":
		return "s.work_id IN (SELECT work_id FROM works WHERE source_work_id=?)", []any{term.Value}
	case "uid":
		return "s.author_id IN (SELECT author_id FROM authors WHERE source_author_id=?)", []any{term.Value}
	case "author", "user":
		column := "display_name"
		if term.Field == "user" {
			column = "coalesce(handle,'')"
		}
		return "s.author_id IN (SELECT author_id FROM authors WHERE instr(gallery_normalize(" + column + "),?)>0)", []any{value}
	case "tag":
		return "s.work_id IN (SELECT wt.work_id FROM " + v.table("work_tags") + " wt JOIN " + v.table("tags") + " t USING(tag_id) WHERE t.normalized_key=?)", []any{value}
	case "mytag":
		if !v.personal || v.accountID == "" {
			return "0", nil
		}
		return "s.work_id IN (SELECT aw.work_id FROM personal.work_tags pt JOIN works aw ON aw.platform_id=pt.platform AND aw.relative_path_key=pt.relative_key WHERE pt.account_id=? AND pt.normalized=?)", []any{v.accountID, value}
	}
	match, args := v.textMatches(value, term.Field)
	return "s.work_id IN (" + match + ")", args
}

func (v *View) textMatches(value, field string) (string, []any) {
	sortTable := v.table("work_sort")
	if field == "text" {
		if utf8.RuneCountInString(value) <= 2 {
			fts := v.table("short_fts")
			first, _ := utf8.DecodeRuneInString(value)
			return "SELECT work_id FROM " + v.table("search_docs") + " WHERE work_id IN (SELECT rowid FROM " + fts + " WHERE " + fts[strings.LastIndex(fts, ".")+1:] + " MATCH ?) AND instr(body,?)>0", []any{"u" + strconv.FormatInt(int64(first), 16), value}
		}
		fts := v.table("work_fts")
		return "SELECT rowid FROM " + fts + " WHERE " + fts[strings.LastIndex(fts, ".")+1:] + " MATCH ?", []any{`body: "` + strings.ReplaceAll(value, `"`, `""`) + `"`}
	}
	title := "SELECT work_id FROM " + sortTable + " WHERE instr(title_key,?)>0"
	args := []any{value}
	if utf8.RuneCountInString(value) >= 3 {
		fts := v.table("work_fts")
		title += " AND work_id IN (SELECT rowid FROM " + fts + " WHERE " + fts[strings.LastIndex(fts, ".")+1:] + " MATCH ?)"
		args = append(args, `title: "`+strings.ReplaceAll(value, `"`, `""`)+`"`)
	}
	if field == "title" {
		return title, args
	}
	// Short tag candidates come from the small tag dictionary. Scanning the
	// compact title projection is faster than materializing a ubiquitous rune's
	// FTS posting list and fetching large body documents solely to reject them.
	title += " UNION SELECT work_id FROM " + v.table("work_tags") + " WHERE tag_id IN (SELECT tag_id FROM " + v.table("tags") + " WHERE instr(normalized_key,?)>0)"
	args = append(args, value)
	title += " UNION SELECT work_id FROM " + sortTable + " WHERE author_id IN (SELECT author_id FROM authors WHERE instr(gallery_normalize(display_name),?)>0)"
	return title, append(args, value)
}

func needsCanonical(q protocol.Query) bool {
	for _, key := range []string{"ai", "paid", "from", "to", "pages"} {
		if q.Filters.Get(key) != "" && q.Filters.Get(key) != "all" {
			return true
		}
	}
	return q.Sort == "rating_desc" || q.Sort == "favorite_desc" || q.Filters.Get("my") == "history" || q.Filters.Get("my") == "continue"
}
