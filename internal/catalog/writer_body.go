package catalog

import (
	"database/sql"

	"github.com/RecRivenVI/Gallery-Legacy/internal/mediaorder"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

func writeChildren(t *transaction, p PreparedWork, workID int64, body *preparedRows) error {
	tables, err := body.collections(t.ctx)
	if err != nil {
		return err
	}
	for _, table := range tables {
		seen := map[string]bool{}
		if err = body.each(t.ctx, table, func(c Row) error {
			x := copyRow(c)
			x["work_id"] = workID
			if table == "field_sources" {
				key := metadata.JSON(c)
				if seen[key] {
					return nil
				}
				seen[key] = true
			}
			if table == "social_relations" {
				var id sql.NullInt64
				if err := t.get("SELECT CASE WHEN count(*)=1 THEN min(work_id) END FROM works WHERE platform_id=? AND source_work_id=?", p.Platform, c["target_source_work_id"]).Scan(&id); err != nil {
					return err
				}
				if id.Valid {
					x["target_work_id"] = id.Int64
				}
			}
			return t.insert(table, x, "")
		}); err != nil {
			return err
		}
	}
	return nil
}

func writeMedia(t *transaction, p PreparedWork, workID int64, exists bool, body *preparedRows) error {
	var disabled, previews bool
	if err := t.get(`SELECT EXISTS(SELECT 1 FROM field_sources WHERE work_id=? AND field='media.coverDisabled'),EXISTS(SELECT 1 FROM field_sources WHERE work_id=? AND field='media.extractedPreviews')`, workID, workID).Scan(&disabled, &previews); err != nil {
		return err
	}
	var chosen mediaorder.Cover
	large := p.StageFile != ""
	oldIDs, ids := map[string]int64{}, map[string]int64{}
	if large {
		if err := t.exec("CREATE TEMP TABLE IF NOT EXISTS incoming_media(key TEXT PRIMARY KEY) WITHOUT ROWID"); err != nil {
			return err
		}
		if err := t.exec("DELETE FROM incoming_media"); err != nil {
			return err
		}
	} else if exists {
		rows, err := t.query("SELECT relative_path_key,media_id FROM media WHERE work_id=?", workID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var key string
			var id int64
			if err = rows.Scan(&key, &id); err != nil {
				rows.Close()
				return err
			}
			oldIDs[key] = id
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	err := body.each(t.ctx, "media", func(m Row) error {
		x := copyRow(m)
		key := text(x["relative_path_key"])
		id := oldIDs[key]
		if large && exists {
			err := t.get("SELECT media_id FROM media WHERE work_id=? AND relative_path_key=?", workID, key).Scan(&id)
			if err != nil && err != sql.ErrNoRows {
				return err
			}
		}
		conflict := "work_id,relative_path_key"
		if id == 0 {
			conflict = ""
			var err error
			id, err = t.id("media")
			if err != nil {
				return err
			}
		}
		x["media_id"], x["work_id"] = id, workID
		candidate := mediaorder.Cover{ID: id, Kind: text(x["filesystem_media_type"]), Name: text(x["filesystem_file_name"]), Relative: text(x["relative_path"])}
		if !disabled && mediaorder.Better(candidate, chosen, previews) {
			chosen = candidate
		}
		if large {
			if err := t.exec("INSERT INTO incoming_media VALUES (?)", key); err != nil {
				return err
			}
		} else {
			ids[key] = id
			delete(oldIDs, key)
		}
		return t.insert("media", x, conflict)
	})
	if err != nil {
		return err
	}
	if large {
		if err = t.exec("DELETE FROM media WHERE work_id=? AND relative_path_key NOT IN (SELECT key FROM incoming_media)", workID); err != nil {
			return err
		}
	} else {
		for _, id := range oldIDs {
			if err = t.exec("DELETE FROM media WHERE media_id=?", id); err != nil {
				return err
			}
		}
	}
	if err = storeCover(t, workID, chosen); err != nil {
		return err
	}
	return nil
}
