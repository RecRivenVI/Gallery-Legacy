package catalog

import (
	"database/sql"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"time"
)

func (w *Writer) write(t *transaction, p PreparedWork, rev int64) error {
	started := time.Now()
	var searchTime int64
	defer func() { w.Metrics.Catalog.Add(time.Since(started).Nanoseconds() - searchTime) }()
	var authorID int64
	e := t.get("SELECT author_id FROM authors WHERE platform_id=? AND relative_path_key=?", p.Platform, p.AuthorKey).Scan(&authorID)
	if e == sql.ErrNoRows {
		authorID, e = t.id("author")
		if e != nil {
			return e
		}
		r := DirectoryAuthor(p.Platform, text(p.Author["folder_name"]))
		r["author_id"] = authorID
		if e = t.insert("authors", r, ""); e != nil {
			return e
		}
		if e = t.exec("UPDATE live_stats SET authors=authors+1 WHERE singleton=1"); e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	var workID, oldMedia int64
	var oldState string
	var oldSource sql.NullString
	var oldShape sql.NullInt64
	exists := true
	e = t.get("SELECT work_id,media_count,metadata_state,metadata_shape_id,source_work_id FROM works WHERE platform_id=? AND relative_path_key=?", p.Platform, p.Key).Scan(&workID, &oldMedia, &oldState, &oldShape, &oldSource)
	if e == sql.ErrNoRows {
		exists = false
		workID, e = t.id("work")
	}
	if e != nil {
		return e
	}
	if exists {
		t.updated++
	} else {
		t.added++
	}
	oldTags := []int64{}
	var rows *sql.Rows
	if exists {
		rows, e = t.query("SELECT tag_id FROM work_tags WHERE work_id=?", workID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var id int64
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return e
			}
			oldTags = append(oldTags, id)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
	}
	var shapeID any
	if p.Shape != nil {
		r := copyRow(p.Shape)
		r["first_seen_at_ms"] = time.Now().UnixMilli()
		r["last_seen_at_ms"] = r["first_seen_at_ms"]
		var id int64
		e = t.get("SELECT metadata_shape_id FROM metadata_shapes WHERE platform_id=? AND signature_version=1 AND policy_version=1 AND shape_hash=?", p.Platform, r["shape_hash"]).Scan(&id)
		if e == sql.ErrNoRows {
			if e = t.insert("metadata_shapes", r, ""); e != nil {
				return e
			}
			if e = t.get("SELECT metadata_shape_id FROM metadata_shapes WHERE platform_id=? AND shape_hash=?", p.Platform, r["shape_hash"]).Scan(&id); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		shapeID = id
		if e = t.exec("UPDATE metadata_shapes SET last_seen_at_ms=?,representative_metadata_relative_path=min(coalesce(representative_metadata_relative_path,?),?) WHERE metadata_shape_id=?", r["last_seen_at_ms"], r["representative_metadata_relative_path"], r["representative_metadata_relative_path"], id); e != nil {
			return e
		}
	}
	if oldShape.Valid && (shapeID == nil || shapeID != oldShape.Int64) {
		if e = t.exec("UPDATE metadata_shapes SET work_count=work_count-1 WHERE metadata_shape_id=?", oldShape.Int64); e != nil {
			return e
		}
	}
	if shapeID != nil && (!oldShape.Valid || shapeID != oldShape.Int64) {
		if e = t.exec("UPDATE metadata_shapes SET work_count=work_count+1 WHERE metadata_shape_id=?", shapeID); e != nil {
			return e
		}
	}
	r := copyRow(p.Work)
	r["work_id"] = workID
	r["author_id"] = authorID
	r["metadata_shape_id"] = shapeID
	workConflict := ""
	if exists {
		workConflict = "platform_id,relative_path_key"
	}
	if e = t.insert("works", r, workConflict); e != nil {
		return e
	}
	if e = writeDetails(t, p, workID); e != nil {
		return e
	}
	if exists {
		for _, table := range []string{"work_access", "work_text", "work_text_sources", "structured_sources", "field_sources", "work_tags", "social_relations", "work_metrics", "media_declarations"} {
			if p.MetadataOnly && table == "media_declarations" {
				continue
			}
			if e = t.exec("DELETE FROM "+table+" WHERE work_id=?", workID); e != nil {
				return e
			}
		}
	}
	for _, id := range oldTags {
		if e = t.exec("UPDATE tags SET work_count=work_count-1 WHERE tag_id=?", id); e != nil {
			return e
		}
	}
	body, err := openPrepared(t.ctx, p)
	if err != nil {
		return err
	}
	defer body.close()
	if !p.MetadataOnly && p.Qualified {
		if err = t.exec("DELETE FROM live_scan_files WHERE work_id=?", workID); err != nil {
			return err
		}
	}
	if err = writeChildren(t, p, workID, body); err != nil {
		return err
	}
	for i, tag := range p.Normalized.Tags {
		var id int64
		e = t.get("SELECT tag_id FROM tags WHERE display_value=?", tag).Scan(&id)
		if e == sql.ErrNoRows {
			id, e = t.id("tag")
			if e != nil {
				return e
			}
			if e = t.insert("tags", Row{"tag_id": id, "display_value": tag, "normalized_value": nil, "work_count": int64(0)}, ""); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		if e = t.insert("work_tags", Row{"tag_id": id, "work_id": workID, "ordinal": i, "sort_at_ms": p.Work["sort_at_ms"]}, ""); e != nil {
			return e
		}
		if e = t.exec("UPDATE tags SET work_count=work_count+1 WHERE tag_id=?", id); e != nil {
			return e
		}
	}
	if !p.MetadataOnly {
		if err = writeMedia(t, p, workID, exists, body); err != nil {
			return err
		}
	} else {
		if err = refreshCover(t, workID); err != nil {
			return err
		}
	}
	delta := int64(0)
	if !exists {
		delta = 1
		if e = t.exec("UPDATE authors SET work_count=work_count+1 WHERE author_id=?", authorID); e != nil {
			return e
		}
	}
	if e = t.exec("UPDATE live_stats SET works=works+?,media=media+? WHERE singleton=1", delta, integer(p.Work["media_count"])-oldMedia); e != nil {
		return e
	}
	if e = t.exec("UPDATE live_platform_stats SET count_works=count_works+?,count_media=count_media+?,last_revision=? WHERE platform_id=?", delta, integer(p.Work["media_count"])-oldMedia, rev, p.Platform); e != nil {
		return e
	}
	if oldState != "" {
		if e = t.exec("UPDATE live_metadata_stats SET count=count-1 WHERE metadata_state=?", oldState); e != nil {
			return e
		}
	}
	if e = t.exec("INSERT INTO live_metadata_stats VALUES (?,1) ON CONFLICT(metadata_state) DO UPDATE SET count=count+1", p.Work["metadata_state"]); e != nil {
		return e
	}
	if p.Qualified && p.Fingerprint != "" {
		if e = t.exec("INSERT INTO live_scan_works VALUES (?,?,?,?,?,?) ON CONFLICT(platform_id,relative_path_key) DO UPDATE SET fingerprint=excluded.fingerprint,adapter_version=excluded.adapter_version,authority_at_ms=excluded.authority_at_ms,authority_source_id=excluded.authority_source_id", p.Platform, p.Key, p.Fingerprint, metadata.Versions[p.Platform], p.AuthorityTime, p.AuthorityID); e != nil {
			return e
		}
		projection, err := EncodeAuthority(p)
		if err != nil {
			return err
		}
		if e = t.exec("INSERT INTO live_scan_work_profiles VALUES (?,?,?) ON CONFLICT(platform_id,relative_path_key) DO UPDATE SET projection=excluded.projection", p.Platform, p.Key, projection); e != nil {
			return e
		}
	} else {
		if e = t.exec("DELETE FROM live_scan_works WHERE platform_id=? AND relative_path_key=?", p.Platform, p.Key); e != nil {
			return e
		}
	}
	if e = t.exec(`UPDATE social_relations SET target_work_id=(SELECT CASE WHEN count(*)=1 THEN min(work_id) END FROM works WHERE platform_id=? AND source_work_id=?) WHERE target_platform_id=? AND target_source_work_id=?`, p.Platform, p.Work["source_work_id"], p.Platform, p.Work["source_work_id"]); e != nil {
		return e
	}
	if oldSource.Valid && oldSource.String != text(p.Work["source_work_id"]) {
		if e = t.exec(`UPDATE social_relations SET target_work_id=(SELECT CASE WHEN count(*)=1 THEN min(work_id) END FROM works WHERE platform_id=? AND source_work_id=?) WHERE target_platform_id=? AND target_source_work_id=?`, p.Platform, oldSource.String, p.Platform, oldSource.String); e != nil {
			return e
		}
	}
	searchStarted := time.Now()
	e = refreshWork(t, workID, exists)
	searchTime = time.Since(searchStarted).Nanoseconds()
	w.Metrics.Search.Add(searchTime)
	if e != nil {
		return e
	}
	for _, tag := range oldTags {
		t.tags[tag] = true
	}
	t.authors[authorID] = true
	return nil
}
