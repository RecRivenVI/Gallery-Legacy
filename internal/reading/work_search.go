package reading

import (
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
)

func (v *View) workPage(q protocol.Query, offset int64) (searchResult, error) {
	var result searchResult
	order := workOrders[q.Sort]
	from := v.table("work_sort") + " s"
	mode := "browse"
	conditions := []string{}
	args := []any{}
	if q.PlatformID != nil {
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
		if v.live {
			conditions = append(conditions, "s.has_readable=1")
		} else {
			conditions = append(conditions, "EXISTS(SELECT 1 FROM media m WHERE m.work_id=s.work_id AND gallery_visible_media(m.filesystem_file_name,EXISTS(SELECT 1 FROM field_sources fs WHERE fs.work_id=s.work_id AND fs.field='media.extractedPreviews'))=1)")
		}
	}
	if q.Tag != nil {
		conditions = append(conditions, "EXISTS(SELECT 1 FROM "+v.table("work_tags")+" wt JOIN "+v.table("tags")+" t USING(tag_id) WHERE wt.work_id=s.work_id AND t.display_value=?)")
		args = append(args, *q.Tag)
		mode = "tag_exact"
	}
	text := catalog.NormalizeQuery(q.Text)
	if text != "" {
		from += " JOIN " + v.table("search_docs") + " d ON d.work_id=s.work_id"
		short := utf8.RuneCountInString(text) <= 2
		if v.live && short {
			conditions = append(conditions, "((s.work_id IN (SELECT rowid FROM "+v.table("short_fts")+" WHERE "+v.table("short_fts")+" MATCH ?) AND (instr(d.title,?)>0 OR instr(d.tags,?)>0 OR instr(d.body,?)>0)) OR EXISTS(SELECT 1 FROM "+v.table("authors")+" la WHERE la.author_id=s.author_id AND instr(la.name_key,?)>0))")
			first, _ := utf8.DecodeRuneInString(strings.TrimLeft(text, " "))
			args = append(args, "u"+strconv.FormatInt(int64(first), 16), text, text, text, text)
			mode = "short_exact"
		} else if v.live {
			conditions = append(conditions, "(s.work_id IN (SELECT rowid FROM "+v.table("work_fts")+" WHERE "+v.table("work_fts")+" MATCH ?) OR EXISTS(SELECT 1 FROM "+v.table("authors")+" la WHERE la.author_id=s.author_id AND instr(la.name_key,?)>0))")
			args = append(args, `"`+strings.ReplaceAll(text, `"`, `""`)+`"`, text)
			mode = "trigram_fts"
		} else if short {
			from += " JOIN " + v.table("short_fts") + " sf ON sf.rowid=s.work_id"
			conditions = append(conditions, "short_fts MATCH ?", "(instr(d.title,?)>0 OR instr(d.author,?)>0 OR instr(d.tags,?)>0 OR instr(d.body,?)>0)")
			first, _ := utf8.DecodeRuneInString(strings.TrimLeft(text, " "))
			args = append(args, "u"+strconv.FormatInt(int64(first), 16), text, text, text, text)
			mode = "short_exact"
		} else {
			from += " JOIN " + v.table("work_fts") + " f ON f.rowid=s.work_id"
			conditions = append(conditions, "work_fts MATCH ?")
			args = append(args, `"`+strings.ReplaceAll(text, `"`, `""`)+`"`)
			mode = "trigram_fts"
		}
	}
	total, err := v.count(from, conditions, args)
	if err != nil {
		return result, err
	}
	if q.Cursor != nil {
		conditions = append(conditions, "(s."+order.column+" "+order.operator+" ? OR (s."+order.column+"=? AND s.work_id "+order.operator+" ?))")
		value, err := cursorNumber(q)
		if err != nil {
			return result, err
		}
		args = append(args, value, value, q.Cursor["workId"])
	}
	args = append(args, q.Limit, offset)
	rows, err := v.rows("SELECT s.work_id,s."+order.column+" sort_value FROM "+from+where(conditions)+" ORDER BY s."+order.column+" "+order.direction+",s.work_id "+order.direction+" LIMIT ? OFFSET ?", args...)
	return searchResult{rows: rows, total: total, mode: mode, cursor: nextCursor(rows, "workId", "work_id")}, err
}
