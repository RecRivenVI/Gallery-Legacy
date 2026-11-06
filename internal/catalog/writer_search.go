package catalog

import (
	"database/sql"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"regexp"
	"strconv"
	"strings"
)

var markup = regexp.MustCompile(`<[^>]{0,1000}[^>]{0,1000}[^>]{0,48}>`)
var invisible = regexp.MustCompile(`[\x{200b}-\x{200f}\x{2060}\x{feff}]`)
var namedEntity = regexp.MustCompile(`(?i)&(?:amp|lt|gt|quot|apos|#39);`)
var numericEntity = regexp.MustCompile(`(?i)&#(?:x([0-9a-f]+)|(\d+));`)

func Normalize(s string) string {
	return normalizeSpaces(normalizedText(s))
}

func normalizedText(s string) string {
	s = norm.NFKC.String(s)
	if strings.ContainsAny(s, "\u200b\u200c\u200d\u200e\u200f\u2060\ufeff") {
		s = invisible.ReplaceAllString(s, "")
	}
	if strings.Contains(s, "<") {
		s = markup.ReplaceAllString(s, " ")
	}
	if strings.Contains(s, "&") {
		s = namedEntity.ReplaceAllStringFunc(s, decodeNamedEntity)
	}
	if strings.Contains(s, "&#") {
		s = numericEntity.ReplaceAllStringFunc(s, decodeNumericEntity)
	}
	return cases.Lower(language.Und).String(s)
}

func decodeNamedEntity(e string) string {
	return map[string]string{"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&#39;": "'"}[strings.ToLower(e)]
}

func decodeNumericEntity(e string) string {
	m := numericEntity.FindStringSubmatch(e)
	base := 10
	v := m[2]
	if m[1] != "" {
		base = 16
		v = m[1]
	}
	n, err := strconv.ParseInt(v, base, 32)
	if err != nil || n < 0 || n > 0x10ffff {
		return " "
	}
	return string(rune(n))
}
func refreshWork(t *transaction, id int64, exists bool) error {
	if exists {
		for _, table := range []string{"live_work_sort", "live_search_docs", "live_work_tags", "live_work_fts", "live_short_fts"} {
			column := "work_id"
			if strings.HasSuffix(table, "fts") {
				column = "rowid"
			}
			if e := t.exec("DELETE FROM "+table+" WHERE "+column+"=?", id); e != nil {
				return e
			}
		}
	}
	var platform, title, relative, author, tags, body, bodyFormat string
	var source sql.NullString
	var authorID, sortAt, images, videos int64
	e := t.get(`SELECT w.platform_id,w.author_id,w.sort_at_ms,w.title,w.relative_path,w.source_work_id,a.display_name||' '||coalesce(a.handle,'')||' '||coalesce(a.source_author_id,''),coalesce(x.source_text,''),coalesce(x.source_format,'plain'),w.image_count,w.video_count FROM works w JOIN authors a USING(author_id) LEFT JOIN work_text x USING(work_id) WHERE w.work_id=?`, id).Scan(&platform, &authorID, &sortAt, &title, &relative, &source, &author, &body, &bodyFormat, &images, &videos)
	if e != nil {
		return e
	}
	rows, e := t.query("SELECT t.display_value,wt.tag_id FROM work_tags wt JOIN tags t USING(tag_id) WHERE wt.work_id=? ORDER BY wt.ordinal", id)
	if e != nil {
		return e
	}
	tagIDs := []int64{}
	names := []string{}
	for rows.Next() {
		var name string
		var tag int64
		if e = rows.Scan(&name, &tag); e != nil {
			rows.Close()
			return e
		}
		names = append(names, name)
		tagIDs = append(tagIDs, tag)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	tags = strings.Join(names, " ")
	var extracted int
	e = t.get("SELECT EXISTS(SELECT 1 FROM field_sources WHERE work_id=? AND field='media.extractedPreviews')", id).Scan(&extracted)
	if e != nil {
		return e
	}
	readable := 0
	rows, e = t.query("SELECT filesystem_file_name FROM media WHERE work_id=?", id)
	if e != nil {
		return e
	}
	for rows.Next() {
		var name string
		if e = rows.Scan(&name); e != nil {
			rows.Close()
			return e
		}
		if presentation(name, extracted == 1) {
			readable = 1
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	image, video := 0, 0
	if images > 0 {
		image = 1
	}
	if videos > 0 {
		video = 1
	}
	normalizedTitle, normalizedTags, normalizedBody, normalizedSource := t.normalize(title), t.normalize(tags), t.normalize(metadata.PlainText(body, bodyFormat)), t.normalize(source.String)
	if e = t.exec("INSERT INTO live_work_sort VALUES (?,?,?,?,?,?,?,?,?)", id, platform, authorID, sortAt, normalizedTitle, t.normalize(basename(relative)), image, video, readable); e != nil {
		return e
	}
	doc := []any{id, platform, t.normalize(title + " " + source.String), t.normalize(author), normalizedTags, normalizedBody}
	if e = t.exec("INSERT INTO live_search_docs VALUES (?,?,?,?,?,?)", doc...); e != nil {
		return e
	}
	if e = t.exec("INSERT INTO live_work_fts(rowid,title,author,tags,body) VALUES (?,?,?,?,?)", id, doc[2], "", doc[4], doc[5]); e != nil {
		return e
	}
	grams := []string{}
	seen := map[rune]bool{}
	for _, s := range []string{normalizedTitle, normalizedTags, normalizedSource, normalizedBody} {
		for _, r := range s {
			if r != ' ' && !seen[r] {
				seen[r] = true
				grams = append(grams, "u"+strconv.FormatInt(int64(r), 16))
			}
		}
	}
	if e = t.exec("INSERT INTO live_short_fts(rowid,terms) VALUES (?,?)", id, strings.Join(grams, " ")); e != nil {
		return e
	}
	for _, tag := range tagIDs {
		if e = t.exec("INSERT INTO live_work_tags VALUES (?,?)", id, tag); e != nil {
			return e
		}
		t.tags[tag] = true
	}
	return nil
}
func refreshAuthor(t *transaction, id int64) error {
	var platform, key, name string
	var source sql.NullString
	var latest sql.NullInt64
	var count int64
	e := t.get("SELECT platform_id,relative_path_key,source_author_id,display_name||' '||coalesce(handle,'')||' '||coalesce(source_author_id,''),latest_work_at_ms,work_count FROM authors WHERE author_id=?", id).Scan(&platform, &key, &source, &name, &latest, &count)
	if e != nil {
		return e
	}
	identity := key
	if source.Valid {
		identity = source.String
	}
	at := int64(-9223372036854775808)
	if latest.Valid {
		at = latest.Int64
	}
	if e = t.exec("DELETE FROM live_authors WHERE author_id=?", id); e != nil {
		return e
	}
	return t.exec("INSERT INTO live_authors VALUES (?,?,?,?,?,?,?,?)", id, platform, key, source, identity, t.normalize(name), at, count)
}
func refreshTag(t *transaction, id int64) error {
	var name string
	var count int64
	if e := t.get("SELECT display_value,work_count FROM tags WHERE tag_id=?", id).Scan(&name, &count); e != nil {
		return e
	}
	if e := t.exec("DELETE FROM live_tags WHERE tag_id=?", id); e != nil {
		return e
	}
	return t.exec("INSERT INTO live_tags VALUES (?,?,?,?)", id, name, t.normalize(name), count)
}
