package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

var corpusWorks = map[string]int64{"pixiv": 110000, "pixivFANBOX": 1500, "Gank": 250, "Fantia": 1000, "Patreon": 150, "Pawchive": 2400, "X": 3200, "微博": 270000, "Venera": 1500}
var corpusAuthors = map[string]int64{"pixiv": 1000, "pixivFANBOX": 6, "Gank": 5, "Fantia": 8, "Patreon": 2, "Pawchive": 50, "X": 30, "微博": 1653, "Venera": 75}

func seed(ctx context.Context, root string) error {
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		return fmt.Errorf("new corpus directory required")
	}
	sources := map[string]string{}
	def, err := api.LoadCatalog()
	if err != nil {
		return err
	}
	for _, p := range def.Platforms {
		sources[p.ID] = filepath.Join(root, "sources", p.ID)
		if err = os.MkdirAll(sources[p.ID], 0700); err != nil {
			return err
		}
	}
	run := filepath.Join(root, "instance")
	if err = catalog.CreateLive(ctx, run, sources); err != nil {
		return err
	}
	w, err := catalog.Open(filepath.Join(run, "live/catalog.sqlite"))
	if err != nil {
		return err
	}
	defer w.Close()
	normalized, _ := metadata.Parse("pixiv", "700", "prototype", []byte(`{"id":"1","title":"prototype","user":{"id":"700","name":"prototype"}}`))
	prototype := catalog.Fill("pixiv", "700", "prototype", `700\prototype`, 1790000000000000000, "valid", nil, nil, normalized, "", "", []catalog.File{{Relative: "1.png", Key: "1.png", Name: "1.png", Extension: ".png", Kind: "image", Size: 12, Mtime: 1790000000000000000}})
	if _, err = w.BatchWithAuthors(ctx, []catalog.PreparedWork{prototype}, []catalog.AuthorEnd{{Platform: "pixiv", Key: "700", Complete: true}}); err != nil {
		return err
	}
	tx, err := w.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{"CREATE TEMP TABLE seed_work AS SELECT * FROM works", "CREATE TEMP TABLE seed_author AS SELECT * FROM authors", "CREATE TEMP TABLE seed_media AS SELECT * FROM media", "UPDATE works SET cover_media_id=NULL", "DELETE FROM works", "DELETE FROM authors", "DELETE FROM tags", "DELETE FROM live_work_sort;DELETE FROM live_search_docs;DELETE FROM live_work_tags;DELETE FROM live_work_fts;DELETE FROM live_short_fts;DELETE FROM live_authors;DELETE FROM live_tags;DELETE FROM live_scan_works;DELETE FROM live_scan_authors;"} {
		if _, err = tx.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	var workBase, authorBase int64
	for _, p := range def.Platforms {
		count, authors := corpusWorks[p.ID], corpusAuthors[p.ID]
		platform := "'" + p.ID + "'"
		workID := fmt.Sprintf("%d+n", workBase)
		authorID := fmt.Sprintf("%d+((n-1)%%%d)+1", authorBase, authors)
		relative := fmt.Sprintf("printf('author-%%06d\\work-%%06d',((n-1)%%%d)+1,n)", authors)
		title := `printf('合成 sample %s %06d',CASE n%4 WHEN 0 THEN 'rain 风景' WHEN 1 THEN 'city 城市' WHEN 2 THEN 'manga 漫画' ELSE 'scene 山水' END,n)`
		video := "0"
		if p.ID == "微博" {
			video = "(n%20=0)"
		}
		overrides := map[string]string{"author_id": fmt.Sprintf("%d+n", authorBase), "platform_id": platform, "relative_path": "printf('author-%06d',n)", "relative_path_key": "printf('author-%06d',n)", "folder_name": "printf('author-%06d',n)", "source_author_id": "cast(n AS TEXT)", "display_name": "printf('author-%06d',n)", "handle": "printf('user-%06d',n)", "work_count": "0", "latest_work_id": "NULL", "latest_work_at_ms": "NULL"}
		if err = copyRows(ctx, tx, "authors", authors, overrides); err != nil {
			return err
		}
		overrides = map[string]string{"work_id": workID, "platform_id": platform, "author_id": authorID, "relative_path": relative, "relative_path_key": relative, "source_work_id": "cast(" + workID + " AS TEXT)", "title": title, "published_at_ms": "1767225600000+n*60000", "sort_at_ms": "1767225600000+n*60000", "cover_media_id": workID, "image_count": "1-" + video, "video_count": video, "media_count": "1"}
		if err = copyRows(ctx, tx, "works", count, overrides); err != nil {
			return err
		}
		overrides = map[string]string{"media_id": workID, "work_id": workID, "filesystem_media_type": "CASE WHEN " + video + " THEN 'video' ELSE 'image' END"}
		if err = copyRows(ctx, tx, "media", count, overrides); err != nil {
			return err
		}
		workBase += count
		authorBase += authors
	}
	queries := []string{
		`UPDATE authors SET work_count=(SELECT count(*) FROM works w WHERE w.author_id=authors.author_id),latest_work_at_ms=(SELECT max(sort_at_ms) FROM works w WHERE w.author_id=authors.author_id)`,
		`INSERT INTO tags(tag_id,display_value,work_count) VALUES(1,'synthetic',0)`,
		`WITH RECURSIVE n(x) AS(VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<63) INSERT INTO tags(tag_id,display_value,work_count) SELECT x+2,'标签'||x,0 FROM n`,
		`INSERT INTO work_tags SELECT 1,work_id,0,sort_at_ms FROM works`,
		`INSERT INTO work_tags SELECT 2+(work_id%64),work_id,1,sort_at_ms FROM works`,
		`UPDATE tags SET work_count=(SELECT count(*) FROM work_tags wt WHERE wt.tag_id=tags.tag_id)`,
		`INSERT INTO work_text(work_id,source_format,source_text,plain_text) SELECT work_id,'plain','仅正文 hiddenbody secret','仅正文 hiddenbody secret' FROM works`,
		`INSERT INTO work_metrics(work_id,likes,views,bookmarks) SELECT work_id,work_id%1024,work_id*100,work_id%700 FROM works`,
		`INSERT INTO work_details SELECT work_id,CASE WHEN work_id%4=2 THEN 'manga' ELSE 'illust' END,CASE WHEN platform_id='pixiv' THEN work_id%3 ELSE NULL END,'',json_object('workType',CASE WHEN work_id%4=2 THEN 'manga' ELSE 'illust' END,'rating',CASE WHEN platform_id='pixiv' THEN work_id%3 ELSE NULL END,'tools',json('[]')) FROM works`,
		`INSERT INTO live_work_sort SELECT work_id,platform_id,author_id,sort_at_ms,lower(title),lower(relative_path),image_count>0,video_count>0,1 FROM works`,
		`INSERT INTO live_search_docs SELECT w.work_id,w.platform_id,lower(w.title||' '||w.source_work_id),a.display_name||' '||a.handle||' '||a.source_author_id,'synthetic 标签'||(w.work_id%64),'仅正文 hiddenbody secret' FROM works w JOIN authors a USING(author_id)`,
		`INSERT INTO live_work_fts(rowid,title,author,tags,body) SELECT work_id,title,'',tags,body FROM live_search_docs`,
		`INSERT INTO live_work_tags SELECT work_id,tag_id FROM work_tags`,
		`INSERT INTO live_authors SELECT author_id,platform_id,relative_path_key,source_author_id,source_author_id,display_name||' '||handle||' '||source_author_id,coalesce(latest_work_at_ms,0),work_count FROM authors`,
		`INSERT INTO live_tags SELECT tag_id,display_value,lower(display_value),work_count FROM tags`,
		`UPDATE live_stats SET works=(SELECT count(*) FROM works),media=(SELECT count(*) FROM media),authors=(SELECT count(*) FROM authors)`,
		`DELETE FROM live_metadata_stats;INSERT INTO live_metadata_stats SELECT metadata_state,count(*) FROM works GROUP BY metadata_state`,
		`UPDATE live_platform_stats SET count_works=(SELECT count(*) FROM works w WHERE w.platform_id=live_platform_stats.platform_id),count_media=(SELECT count(*) FROM works w WHERE w.platform_id=live_platform_stats.platform_id),last_revision=1`,
		`UPDATE live_meta SET revision=1`,
		`UPDATE live_id_high_water SET value=CASE entity WHEN 'author' THEN (SELECT max(author_id) FROM authors) WHEN 'work' THEN (SELECT max(work_id) FROM works) WHEN 'media' THEN (SELECT max(media_id) FROM media) WHEN 'tag' THEN (SELECT max(tag_id) FROM tags) END`,
	}
	for _, q := range queries {
		if _, err = tx.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("seed corpus projection: %w", err)
		}
	}
	// A safe superset is exact after the reader's instr predicate. The same
	// characters exist in all generated variants; no query can miss a rune.
	seen := map[rune]bool{}
	var grams []string
	for _, r := range "合成 sample rain 风景 city 城市 manga 漫画 scene 山水 synthetic 标签仅正文hiddenbodysecret0123456789" {
		if r != ' ' && !seen[r] {
			seen[r] = true
			grams = append(grams, "u"+strconv.FormatInt(int64(r), 16))
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO live_short_fts(rowid,terms) SELECT work_id,? FROM works", strings.Join(grams, " ")); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if err = w.Verify(ctx); err != nil {
		return err
	}
	if _, err = w.DB.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return err
	}
	marker, _ := json.Marshal(map[string]any{"kind": "gallery-query-corpus", "works": workBase, "platforms": corpusWorks, "authors": authorBase, "sourceFiles": 0})
	return os.WriteFile(filepath.Join(root, ".gallery-query-corpus.json"), marker, 0600)
}

func copyRows(ctx context.Context, tx *sql.Tx, table string, count int64, overrides map[string]string) error {
	template := map[string]string{"authors": "seed_author", "works": "seed_work", "media": "seed_media"}[table]
	rows, err := tx.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return err
	}
	var columns, values []string
	for rows.Next() {
		var cid, notnull, pk int
		var name, kind string
		var value any
		if err = rows.Scan(&cid, &name, &kind, &notnull, &value, &pk); err != nil {
			rows.Close()
			return err
		}
		columns = append(columns, `"`+name+`"`)
		expr := `s."` + name + `"`
		if v, ok := overrides[name]; ok {
			expr = v
		}
		values = append(values, expr)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	query := fmt.Sprintf("WITH RECURSIVE seq(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?) INSERT INTO %s(%s) SELECT %s FROM seq CROSS JOIN %s s", table, strings.Join(columns, ","), strings.Join(values, ","), template)
	_, err = tx.ExecContext(ctx, query, count)
	if err != nil {
		return fmt.Errorf("seed %s: %w", table, err)
	}
	return nil
}
