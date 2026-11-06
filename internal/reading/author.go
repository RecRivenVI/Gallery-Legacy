package reading

import (
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"

	"slices"
)

// Edges include exact source keys and shared manual choices. An ignored pair
// suppresses an automatic key without changing facts parsed by the scanner.
func (v *View) authorEdges() string {
	automatic := `SELECT a.platform_id||':'||a.relative_path_key left_key,b.platform_id||':'||b.relative_path_key right_key FROM author_keys k JOIN authors a ON a.author_id=k.author_id JOIN authors b ON b.platform_id=k.platform_id AND b.source_author_id=k.source_id WHERE a.author_id!=b.author_id AND a.platform_id='pixivFANBOX' AND b.platform_id='pixiv'`
	if !v.enriched {
		automatic = "SELECT '' left_key,'' right_key WHERE 0"
	}
	if !v.personal {
		return automatic
	}
	return `SELECT e.left_key,e.right_key FROM (` + automatic + `) e WHERE NOT EXISTS(SELECT 1 FROM personal.author_links l WHERE l.state='ignored' AND ((l.left_key=e.left_key AND l.right_key=e.right_key) OR (l.left_key=e.right_key AND l.right_key=e.left_key))) UNION SELECT left_key,right_key FROM personal.author_links WHERE state='linked'`
}

func (v *View) linkedIDs(key string) ([]int64, error) {
	ignored := ""
	args := []any{key}
	if v.personal {
		ignored = " AND NOT EXISTS(SELECT 1 FROM personal.author_links l WHERE state='ignored' AND ((l.left_key=? AND l.right_key=authors.platform_id||':'||authors.relative_path_key) OR (l.right_key=? AND l.left_key=authors.platform_id||':'||authors.relative_path_key)))"
		args = append(args, key, key)
	}
	rows, err := v.rows(`WITH RECURSIVE edges AS (`+v.authorEdges()+`),links(key) AS (VALUES(?) UNION SELECT CASE WHEN edges.left_key=links.key THEN edges.right_key ELSE edges.left_key END FROM edges JOIN links ON edges.left_key=links.key OR edges.right_key=links.key) SELECT author_id FROM authors WHERE platform_id||':'||relative_path_key IN (SELECT key FROM links)`+ignored+` ORDER BY platform_id,display_name`, args...)
	if err != nil {
		return nil, err
	}
	ids := []int64{}
	for _, r := range rows {
		ids = append(ids, r["author_id"].(int64))
	}
	return ids, nil
}

func (v *View) AuthorPage(authorID int64) (Row, error) {
	authors, err := v.Authors([]int64{authorID})
	if err != nil || len(authors) == 0 {
		return nil, err
	}
	a, err := v.row("SELECT platform_id,relative_path_key FROM authors WHERE author_id=?", authorID)
	if err != nil {
		return nil, err
	}
	key := text(a["platform_id"]) + ":" + text(a["relative_path_key"])
	stats, err := v.row("SELECT coalesce(sum("+visibleCountSQL("w")+"),0) pages,min(published_at_ms) first_at,max(published_at_ms) last_at FROM works w WHERE author_id=?", authorID)
	if err != nil {
		return nil, err
	}
	types := map[string]int64{}
	if v.enriched {
		rows, err := v.rows("SELECT d.work_type,count(*) n FROM works w JOIN work_details d USING(work_id) WHERE w.author_id=? GROUP BY d.work_type", authorID)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			types[text(row["work_type"])] = row["n"].(int64)
		}
	}
	rows, err := v.rows("SELECT t.tag_id,t.display_value,count(*) n FROM works w JOIN work_tags wt USING(work_id) JOIN tags t USING(tag_id) WHERE w.author_id=? GROUP BY t.tag_id ORDER BY n DESC,t.display_value LIMIT 10", authorID)
	if err != nil {
		return nil, err
	}
	tags := []Row{}
	for _, r := range rows {
		tags = append(tags, Row{"id": id(r["tag_id"]), "label": r["display_value"], "workCount": r["n"]})
	}
	ids, err := v.linkedIDs(key)
	if err != nil {
		return nil, err
	}
	ids = slices.DeleteFunc(ids, func(id int64) bool { return id == authorID })
	linked, err := v.Authors(ids)
	if err != nil {
		return nil, err
	}
	profile, err := v.row("SELECT bio FROM author_profiles WHERE author_id=?", authorID)
	if err != nil {
		return nil, err
	}
	bio := ""
	if profile != nil {
		bio = metadata.PlainText(text(profile["bio"]), "html")

	}
	return Row{"author": authors[0], "bio": bio, "pages": stats["pages"], "firstAt": stats["first_at"], "lastAt": stats["last_at"], "types": types, "tags": tags, "linked": linked, "key": key}, nil
}

func (v *View) Episodes(workID int64) (Row, error) {
	details, err := v.workDetails(workID)
	if err != nil {
		return nil, err
	}
	work, err := v.row("SELECT platform_id,author_id,sort_at_ms,work_id FROM works WHERE work_id=?", workID)
	if err != nil || work == nil {
		return nil, err
	}
	result := Row{"previous": nil, "next": nil}
	for _, side := range []string{"previous", "next"} {
		var row Row
		if details.SeriesID != "" {
			op, order := "<", "DESC"
			if side == "next" {
				op, order = ">", "ASC"
			}
			row, err = v.row("SELECT w.work_id FROM works w JOIN work_details d USING(work_id) WHERE w.platform_id=? AND w.author_id=? AND d.series_id=? AND (w.sort_at_ms,w.work_id) "+op+" (?,?) ORDER BY w.sort_at_ms "+order+",w.work_id "+order+" LIMIT 1", work["platform_id"], work["author_id"], details.SeriesID, work["sort_at_ms"], workID)
		} else {
			episode := details.Previous
			if side == "next" {
				episode = details.Next
			}
			if episode != nil {
				row, err = v.row("SELECT work_id FROM works WHERE platform_id=? AND author_id=? AND source_work_id=? LIMIT 1", work["platform_id"], work["author_id"], episode.ID)
			}
		}
		if err != nil {
			return nil, err
		}
		if row != nil {
			works, err := v.Works([]int64{row["work_id"].(int64)}, "all")
			if err != nil {
				return nil, err
			}
			if len(works) > 0 {
				result[side] = works[0]
			}
		}
	}
	return result, nil
}
