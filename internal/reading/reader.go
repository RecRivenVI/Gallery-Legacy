// Package reading provides transaction-consistent public Catalog projections.
package reading

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"

	_ "modernc.org/sqlite"
)

type Row = map[string]any

type Reader struct {
	DB           *sql.DB
	Epoch        string
	Live         bool
	Enriched     bool
	legacySearch bool
	PersonalFile string
}
type View struct {
	tx           *sql.Tx
	ctx          context.Context
	epoch        string
	live         bool
	enriched     bool
	legacySearch bool
	personal     bool
	accountID    string
}

// Open verifies the format of an existing file. The dataset owner additionally
// validates the configured source bindings before exposing it to requests.
func Open(ctx context.Context, file, epoch string, live bool) (*Reader, error) {
	return OpenBound(ctx, file, epoch, live, nil)
}

// OpenBound checks format and configured source bindings before serving reads.
func OpenBound(ctx context.Context, file, epoch string, live bool, sources map[string]string) (*Reader, error) {
	u := url.URL{Scheme: "file", Path: "/" + strings.ReplaceAll(file, "\\", "/")}
	params := u.Query()
	params.Set("mode", "ro")
	params.Add("_pragma", "foreign_keys(1)")
	params.Add("_pragma", "busy_timeout(1500)")
	u.RawQuery = params.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, fmt.Errorf("open reader: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("open existing reader: %w", err)
	}
	if err = catalog.VerifyContract(ctx, db, catalog.ContractOptions{Live: live, Sources: sources}); err != nil {
		db.Close()
		return nil, err
	}
	var enriched int
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE name='work_details' AND type='table'").Scan(&enriched); err != nil {
		db.Close()
		return nil, fmt.Errorf("read enrichment version: %w", err)
	}
	return &Reader{DB: db, Epoch: epoch, Live: live, Enriched: enriched == 1}, nil
}
func (r *Reader) Close() error { return r.DB.Close() }

func OpenStatic(ctx context.Context, file, search, epoch string) (*Reader, error) {
	return OpenStaticBound(ctx, file, search, epoch, nil)
}

func OpenStaticBound(ctx context.Context, file, search, epoch string, sources map[string]string) (*Reader, error) {
	reader, err := OpenBound(ctx, file, epoch, false, sources)
	if err != nil {
		return nil, err
	}
	reader.DB.SetMaxOpenConns(1)
	u := url.URL{Scheme: "file", Path: "/" + strings.ReplaceAll(search, "\\", "/")}
	params := u.Query()
	params.Set("mode", "ro")
	u.RawQuery = params.Encode()
	if _, err = reader.DB.ExecContext(ctx, "ATTACH DATABASE ? AS search", u.String()); err != nil {
		reader.Close()
		return nil, fmt.Errorf("attach readonly search: %w", err)
	}
	var readableColumn int
	if err = reader.DB.QueryRowContext(ctx, "SELECT count(*) FROM pragma_table_info('work_sort','search') WHERE name='has_readable'").Scan(&readableColumn); err != nil {
		reader.Close()
		return nil, fmt.Errorf("read search projection: %w", err)
	}
	if readableColumn == 0 {
		// Only older immutable recovery files need this connection-local view.
		_, err = reader.DB.ExecContext(ctx, `CREATE TEMP VIEW gallery_work_sort AS SELECT s.*,EXISTS(SELECT 1 FROM main.media m WHERE m.work_id=s.work_id AND gallery_visible_media(m.filesystem_file_name,EXISTS(SELECT 1 FROM main.field_sources fs WHERE fs.work_id=s.work_id AND fs.field='media.extractedPreviews'))=1) AS has_readable FROM search.work_sort s`)
		if err != nil {
			reader.Close()
			return nil, fmt.Errorf("project immutable search: %w", err)
		}
		reader.legacySearch = true
	}
	return reader, nil
}

func (v *View) LiveState() (catalog.LiveState, error) {
	return catalog.ReadLiveSnapshot(v.ctx, v.tx)
}

func (r *Reader) Snapshot(ctx context.Context, fn func(*View) (any, error)) (any, error) {
	connection, err := r.DB.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire catalog reader: %w", err)
	}
	defer connection.Close()
	if r.PersonalFile != "" {
		var attached int
		if err = connection.QueryRowContext(ctx, "SELECT count(*) FROM pragma_database_list WHERE name='personal'").Scan(&attached); err != nil {
			return nil, fmt.Errorf("inspect personal attachment: %w", err)
		}
		if attached == 0 {
			u := url.URL{Scheme: "file", Path: "/" + strings.ReplaceAll(r.PersonalFile, "\\", "/")}
			values := u.Query()
			values.Set("mode", "ro")
			u.RawQuery = values.Encode()
			if _, err = connection.ExecContext(ctx, "ATTACH DATABASE ? AS personal", u.String()); err != nil {
				return nil, fmt.Errorf("attach personal reader: %w", err)
			}
		}
	}
	tx, err := connection.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	accountID, _ := ctx.Value(accountKey{}).(string)
	value, err := fn(&View{tx: tx, ctx: ctx, epoch: r.Epoch, live: r.Live, enriched: r.Enriched, legacySearch: r.legacySearch, personal: r.PersonalFile != "", accountID: accountID})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return value, nil
}

func (v *View) rows(query string, args ...any) ([]Row, error) {
	rows, err := v.tx.QueryContext(v.ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("read catalog: %w", err)
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := []Row{}
	for rows.Next() {
		values := make([]any, len(names))
		pointers := make([]any, len(names))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err = rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := Row{}
		for i, name := range names {
			row[name] = values[i]
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
func (v *View) row(query string, args ...any) (Row, error) {
	rows, err := v.rows(query, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}
func text(value any) string { s, _ := value.(string); return s }
func id(value any) string   { return strconv.FormatInt(value.(int64), 10) }
func flag(value any) any {
	if value == nil {
		return nil
	}
	return value == int64(1)
}
func slash(value any) string { return strings.ReplaceAll(text(value), "\\", "/") }

func (v *View) Media(id int64) (Row, error) {
	return v.row("SELECT m.*,w.platform_id,w.relative_path work_relative_path,w.cover_media_id FROM media m JOIN works w USING(work_id) WHERE m.media_id=?", id)
}

func (v *View) mediaDTO(m Row, previews bool, sizes ...string) (Row, error) {
	identity, err := v.Media(m["media_id"].(int64))
	if err != nil {
		return nil, err
	}
	key := mediaIdentity(identity)
	var stable any
	if identity != nil {
		stable = publicPath(text(identity["platform_id"]), text(identity["work_relative_path"])+"/"+slash(identity["relative_path"]))
	}
	suffix := ""
	if key != "" {
		suffix += "&k=" + key
	}
	if stable != nil {
		suffix += "&p=" + component(stable.(string))
	}
	role, visible := presentation(text(m["filesystem_file_name"]), previews)
	address := func(kind string) string {
		return "/api/v1/" + kind + "/" + id(m["media_id"]) + "?g=" + component(v.epoch) + suffix
	}
	purpose := "display"
	if len(sizes) != 0 {
		purpose = sizes[0]
	}
	fingerprint := imaging.Key(text(identity["platform_id"]), text(identity["work_relative_path"])+"/"+text(m["relative_path"]), m["filesystem_size"].(int64), m["filesystem_mtime_ns"].(int64))
	return (api.MediaSummary{ID: id(m["media_id"]), FileName: text(m["filesystem_file_name"]), RelativePath: slash(m["relative_path"]), Type: text(m["filesystem_media_type"]), Size: m["filesystem_size"].(int64), DurationMs: m["duration_ms"], URL: address("media"), ThumbnailURL: address("thumbnails") + "&purpose=" + purpose + "&v=" + fingerprint, Role: role, DefaultVisible: visible}).Row(), nil
}

func (v *View) Works(ids []int64, mediaType string) ([]Row, error) {
	result := []Row{}
	if len(ids) == 0 {
		return result, nil
	}
	for _, workID := range ids {
		w, err := v.row("SELECT w.*,a.display_name author_name,a.source_author_id FROM works w JOIN authors a USING(author_id) WHERE work_id=?", workID)
		if err != nil {
			return nil, err
		}
		if w == nil {
			continue
		}
		tags, err := v.rows("SELECT t.tag_id,t.display_value FROM work_tags wt JOIN tags t USING(tag_id) WHERE wt.work_id=? ORDER BY wt.ordinal", workID)
		if err != nil {
			return nil, err
		}
		labels := []Row{}
		for _, tag := range tags {
			labels = append(labels, Row{"id": id(tag["tag_id"]), "label": tag["display_value"]})
		}
		mediaQuery := "SELECT m.* FROM media m WHERE work_id=? AND NOT EXISTS(SELECT 1 FROM field_sources f WHERE f.work_id=m.work_id AND f.field='media.coverDisabled')"
		if w["cover_media_id"] != nil && mediaType != "video" {
			mediaQuery = "SELECT m.* FROM media m WHERE work_id=? AND m.media_id=" + id(w["cover_media_id"])
		}
		media, err := v.rows(mediaQuery, workID)
		if err != nil {
			return nil, err
		}
		preview, err := v.extracted(workID)
		if err != nil {
			return nil, err
		}
		sortCover(media, mediaType, preview)
		var cover any
		if len(media) > 0 {
			cover, err = v.mediaDTO(media[0], false)
			if err != nil {
				return nil, err
			}
		}
		source, err := v.row("SELECT source_text FROM work_text_sources WHERE work_id=? AND role='source_link' AND source_format='plain' ORDER BY ordinal LIMIT 1", workID)
		if err != nil {
			return nil, err
		}
		var sourceURL any
		if source != nil && text(source["source_text"]) != "" {
			sourceURL = source["source_text"]
		}
		summary := (api.WorkSummary{ID: id(w["work_id"]), StableID: publicPath(text(w["platform_id"]), text(w["relative_path"])), PlatformID: text(w["platform_id"]), AuthorID: id(w["author_id"]), SourceWorkID: w["source_work_id"], SourceURL: sourceURL, Title: text(w["title"]), AuthorName: text(w["author_name"]), PublishedAtMs: w["published_at_ms"], SortAtMs: w["sort_at_ms"], MetadataState: text(w["metadata_state"]), EnrichmentState: text(w["enrichment_state"]), Flags: Row{"adult": flag(w["is_adult"]), "aiGenerated": flag(w["is_ai_generated"]), "paid": flag(w["is_paid"])}, Counts: Row{"images": w["image_count"], "videos": w["video_count"], "media": w["media_count"]}, Tags: labels, Cover: cover}).Row()
		details, err := v.workDetails(workID)
		if err != nil {
			return nil, err
		}
		readable, err := v.ReadableCount(workID)
		if err != nil {
			return nil, err
		}
		summary["counts"].(map[string]any)["media"] = readable
		summary["details"] = details
		summary["personal"], err = v.personalState(workID)
		if err != nil {
			return nil, err
		}
		summary["language"] = text(w["language"])
		summary["metrics"], err = v.row("SELECT likes,replies,comments,reposts,views,bookmarks FROM work_metrics WHERE work_id=?", workID)
		if err != nil {
			return nil, err
		}
		result = append(result, summary)
	}
	return result, nil
}

func (v *View) extracted(workID int64) (bool, error) {
	row, err := v.row("SELECT 1 FROM field_sources WHERE work_id=? AND field='media.extractedPreviews'", workID)
	return row != nil, err
}

func (v *View) Work(workID int64) (Row, error) {
	items, err := v.Works([]int64{workID}, "all")
	if err != nil || len(items) == 0 {
		return nil, err
	}
	item := items[0]
	preview, err := v.extracted(workID)
	if err != nil {
		return nil, err
	}
	media, err := v.rows("SELECT * FROM media WHERE work_id=?", workID)
	if err != nil {
		return nil, err
	}
	sortMedia(media)
	pages := []Row{}
	var coverID string
	if cover, ok := item["cover"].(Row); ok {
		coverID = text(cover["id"])
	}
	spread := 0
	for _, m := range media {
		_, visible := presentation(text(m["filesystem_file_name"]), preview)
		purpose := "strip"
		if id(m["media_id"]) == coverID {
			purpose = "display"
		} else if visible && spread < 3 {
			purpose = "display"
			spread++
		}
		page, err := v.mediaDTO(m, preview, purpose)
		if err != nil {
			return nil, err
		}
		pages = append(pages, page)
	}
	description, err := v.row("SELECT source_format,source_text,plain_text FROM work_text WHERE work_id=?", workID)
	if err != nil {
		return nil, err
	}
	item["media"] = pages
	item["description"] = nil
	if description != nil {
		plain := description["plain_text"]
		if plain == nil {
			plain = metadata.PlainText(text(description["source_text"]), text(description["source_format"]))
		}
		item["description"] = (api.TextSource{Format: "plain", Text: text(plain)}).Row()
	}
	if err = v.workExtras(workID, item); err != nil {
		return nil, err
	}
	return item, nil
}

func (v *View) Authors(ids []int64) ([]Row, error) {
	items := []Row{}
	for _, authorID := range ids {
		a, err := v.row("SELECT * FROM authors WHERE author_id=?", authorID)
		if err != nil {
			return nil, err
		}
		if a == nil {
			continue
		}
		latest, err := v.row("SELECT work_id FROM works WHERE author_id=? ORDER BY sort_at_ms DESC,work_id DESC LIMIT 1", authorID)
		if err != nil {
			return nil, err
		}
		var cover any
		if latest != nil {
			works, err := v.Works([]int64{latest["work_id"].(int64)}, "all")
			if err != nil {
				return nil, err
			}
			cover = works[0]["cover"]
		}
		profile, err := v.row("SELECT profile_url FROM author_profiles WHERE author_id=?", authorID)
		if err != nil {
			return nil, err
		}
		var source any
		if profile != nil && text(profile["profile_url"]) != "" {
			source = profile["profile_url"]
		}
		items = append(items, (api.AuthorSummary{ID: id(a["author_id"]), StableID: publicPath(text(a["platform_id"]), text(a["relative_path"])), PlatformID: text(a["platform_id"]), SourceAuthorID: a["source_author_id"], Name: text(a["display_name"]), Handle: a["handle"], WorkCount: a["work_count"].(int64), LatestAtMs: a["latest_work_at_ms"], ProfileState: text(a["profile_state"]), SourceURL: source, Cover: cover}).Row())
	}
	return items, nil
}

func (v *View) Resolve(value string) (Row, error) {
	platform, relative, ok := parsePath(value)
	if !ok {
		return nil, nil
	}
	work, err := v.row("SELECT work_id FROM works WHERE platform_id=? AND relative_path_key=?", platform, relative)
	if err != nil {
		return nil, err
	}
	if work != nil {
		item, err := v.Work(work["work_id"].(int64))
		return Row{"kind": "work", "item": item}, err
	}
	author, err := v.row("SELECT author_id FROM authors WHERE platform_id=? AND relative_path_key=?", platform, relative)
	if err != nil || author == nil {
		return nil, err
	}
	items, err := v.Authors([]int64{author["author_id"].(int64)})
	if err != nil {
		return nil, err
	}
	return Row{"kind": "author", "item": items[0]}, nil
}

func (v *View) Chapters(value string) (any, error) {
	resolved, err := v.Resolve(value)
	if err != nil || resolved == nil {
		return nil, err
	}
	item := resolved["item"].(Row)
	if resolved["kind"] == "work" {
		return []Row{item}, nil
	}
	authorID, err := strconv.ParseInt(item["id"].(string), 10, 64)
	if err != nil {
		return nil, err
	}
	rows, err := v.rows("SELECT work_id,relative_path FROM works WHERE author_id=?", authorID)
	if err != nil {
		return nil, err
	}
	sortMedia(rows)
	ids := []int64{}
	for _, row := range rows {
		ids = append(ids, row["work_id"].(int64))
	}
	return v.Works(ids, "all")
}

func (v *View) MediaAtPath(value string) (any, error) {
	platform, relative, ok := parsePath(value)
	if !ok {
		return nil, nil
	}
	parts := strings.Split(relative, "\\")
	if len(parts) < 3 {
		return nil, nil
	}
	row, err := v.row("SELECT m.media_id FROM works w JOIN media m USING(work_id) WHERE w.platform_id=? AND w.relative_path_key=? AND m.relative_path_key=?", platform, strings.Join(parts[:2], "\\"), strings.Join(parts[2:], "\\"))
	if err != nil || row == nil {
		return nil, err
	}
	return id(row["media_id"]), nil
}

func (v *View) Stats() (Row, error) {
	metadata, err := v.rows("SELECT metadata_state,count(*) count FROM works GROUP BY metadata_state")
	if err != nil {
		return nil, err
	}
	if v.live {
		metadata, err = v.rows("SELECT metadata_state,count FROM live_metadata_stats WHERE count>0 ORDER BY metadata_state")
		if err != nil {
			return nil, err
		}
	}
	counts, err := v.row("SELECT (SELECT count(*) FROM works) works,(SELECT count(*) FROM media) media,(SELECT count(*) FROM authors) authors")
	if err != nil {
		return nil, err
	}
	if v.live {
		counts, err = v.row("SELECT works,media,authors FROM live_stats WHERE singleton=1")
		if err != nil {
			return nil, err
		}
		if counts == nil {
			return nil, fmt.Errorf("LIVE_STATS_INVALID")
		}
	}
	states := Row{}
	for _, row := range metadata {
		states[text(row["metadata_state"])] = row["count"]
	}
	counts["metadataStates"] = states
	return counts, nil
}

func (v *View) PlatformStats() ([]Row, error) {
	query := "SELECT platform_id id,count(*) works,sum(media_count) media FROM works GROUP BY platform_id"
	if v.live {
		query = "SELECT platform_id id,count_works works,count_media media FROM live_platform_stats ORDER BY platform_id"
	}
	return v.rows(query)
}
