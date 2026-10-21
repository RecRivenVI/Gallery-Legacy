package reading

import (
	"database/sql/driver"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"modernc.org/sqlite"
)

func init() {
	// A pure SQL projection; no connection-scoped cache or database access.
	sqlite.MustRegisterDeterministicScalarFunction("gallery_visible_media", 2, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
		_, visible := presentation(args[0].(string), args[1] == int64(1))
		if visible {
			return int64(1), nil
		}
		return int64(0), nil
	})
}

type sortOrder struct{ column, direction, operator string }

var workOrders = map[string]sortOrder{
	"date_desc": {"published_sort", "DESC", "<"}, "date_asc": {"published_sort", "ASC", ">"},
	"title_asc": {"title_key", "ASC", ">"}, "title_desc": {"title_key", "DESC", "<"},
	"name_asc": {"name_key", "ASC", ">"}, "name_desc": {"name_key", "DESC", "<"},
}
var authorOrders = map[string]sortOrder{
	"name_asc": {"name_key", "ASC", ">"}, "name_desc": {"name_key", "DESC", "<"},
	"latest_desc": {"latest_sort", "DESC", "<"}, "latest_asc": {"latest_sort", "ASC", ">"},
	"posts_desc": {"work_count", "DESC", "<"}, "posts_asc": {"work_count", "ASC", ">"},
}

type searchResult struct {
	rows   []Row
	total  int64
	mode   string
	cursor map[string]string
}

func (v *View) table(name string) string {
	if v.live {
		return "live_" + name
	}
	return "search." + name
}

func (v *View) Page(kind string, params url.Values, revision *int64) (Row, error) {
	q, err := protocol.ParseQuery(params, kind, v.epoch, revision)
	if err != nil {
		return nil, err
	}
	offset := (q.Page - 1) * q.PageSize
	if q.Cursor != nil {
		offset = 0
	}
	var result searchResult
	switch kind {
	case "works":
		result, err = v.workPage(q, offset)
	case "authors":
		result, err = v.authorPage(q, offset)
	case "tags":
		result, err = v.tagPage(q, offset)
	default:
		return nil, fmt.Errorf("unknown page kind %q", kind)
	}
	if err != nil {
		return nil, err
	}
	ids := []int64{}
	for _, row := range result.rows {
		if kind != "tags" {
			ids = append(ids, row[map[string]string{"works": "work_id", "authors": "author_id"}[kind]].(int64))
		}
	}
	var items []Row
	if kind == "works" {
		items, err = v.Works(ids, q.MediaType)
	} else if kind == "authors" {
		items, err = v.Authors(ids)
	} else {
		items = []Row{}
		for _, row := range result.rows {
			items = append(items, Row{"id": id(row["tag_id"]), "label": row["display_value"], "workCount": row["work_count"]})
		}
	}
	if err != nil {
		return nil, err
	}
	cursor, err := protocol.EncodeCursor(result.cursor, q.Key, revision)
	if err != nil {
		return nil, err
	}
	totalPages := (result.total + q.PageSize - 1) / q.PageSize
	if totalPages < 1 {
		totalPages = 1
	}
	mode := result.mode
	if mode == "" {
		mode = kind
	}
	page := Row{"items": items, "total": result.total, "page": q.Page, "pageSize": q.PageSize, "totalPages": totalPages, "cursor": cursor, "mode": mode}
	if v.live {
		page["revision"] = revision
	}
	return page, nil
}

func where(conditions []string) string {
	if len(conditions) == 0 {
		return ""
	}
	return " WHERE " + strings.Join(conditions, " AND ")
}
func (v *View) count(from string, conditions []string, args []any) (int64, error) {
	row, err := v.row("SELECT count(*) n FROM "+from+where(conditions), args...)
	if err != nil {
		return 0, err
	}
	return row["n"].(int64), nil
}
func cursorNumber(q protocol.Query) (any, error) {
	value := q.Cursor["value"]
	if strings.HasPrefix(q.Sort, "date_") || strings.HasPrefix(q.Sort, "latest_") || strings.HasPrefix(q.Sort, "posts_") {
		return strconv.ParseInt(value, 10, 64)
	}
	return value, nil
}
func nextCursor(rows []Row, field, column string) map[string]string {
	if len(rows) == 0 {
		return nil
	}
	last := rows[len(rows)-1]
	value := last["sort_value"]
	position := map[string]string{field: id(last[column])}
	if value != nil {
		switch x := value.(type) {
		case int64:
			position["value"] = strconv.FormatInt(x, 10)
		case string:
			position["value"] = x
		}
	}
	return position
}

func (v *View) authorPage(q protocol.Query, offset int64) (searchResult, error) {
	var result searchResult
	from := v.table("authors")
	order := authorOrders[q.Sort]
	conditions := []string{}
	args := []any{}
	if q.PlatformID != nil {
		conditions = append(conditions, "platform_id=?")
		args = append(args, *q.PlatformID)
	}
	if text := catalog.NormalizeQuery(q.Text); text != "" {
		conditions = append(conditions, "instr(name_key,?)>0")
		args = append(args, text)
	}
	total, err := v.count(from, conditions, args)
	if err != nil {
		return result, err
	}
	if q.Cursor != nil {
		conditions = append(conditions, "("+order.column+" "+order.operator+" ? OR ("+order.column+"=? AND author_id "+order.operator+" ?))")
		value, err := cursorNumber(q)
		if err != nil {
			return result, err
		}
		args = append(args, value, value, q.Cursor["authorId"])
	}
	args = append(args, q.Limit, offset)
	rows, err := v.rows("SELECT author_id,"+order.column+" sort_value FROM "+from+where(conditions)+" ORDER BY "+order.column+" "+order.direction+",author_id "+order.direction+" LIMIT ? OFFSET ?", args...)
	return searchResult{rows: rows, total: total, cursor: nextCursor(rows, "authorId", "author_id")}, err
}

func (v *View) tagPage(q protocol.Query, offset int64) (searchResult, error) {
	var result searchResult
	conditions := []string{}
	args := []any{}
	if q.PlatformID != nil {
		conditions = append(conditions, "s.platform_id=?")
		args = append(args, *q.PlatformID)
	}
	if text := catalog.NormalizeQuery(q.Text); text != "" {
		conditions = append(conditions, "instr(t.normalized_key,?)>0")
		args = append(args, text)
	}
	from := v.table("tags") + " t JOIN " + v.table("work_tags") + " wt USING(tag_id) JOIN " + v.table("work_sort") + " s USING(work_id)"
	totalRow, err := v.row("SELECT count(DISTINCT t.tag_id) n FROM "+from+where(conditions), args...)
	if err != nil {
		return result, err
	}
	after := "0"
	if q.Cursor != nil {
		after = q.Cursor["tagId"]
	}
	conditions = append(conditions, "t.tag_id>?")
	args = append(args, after, q.Limit, offset)
	rows, err := v.rows("SELECT t.tag_id,t.display_value,count(*) work_count FROM "+from+where(conditions)+" GROUP BY t.tag_id ORDER BY t.tag_id LIMIT ? OFFSET ?", args...)
	return searchResult{rows: rows, total: totalRow["n"].(int64), cursor: nextCursor(rows, "tagId", "tag_id")}, err
}
