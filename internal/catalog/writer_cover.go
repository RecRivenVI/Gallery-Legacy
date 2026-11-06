package catalog

import "github.com/RecRivenVI/Gallery-Legacy/internal/mediaorder"

func refreshCover(t *transaction, workID int64) error {
	var disabled, previews bool
	if err := t.get(`SELECT EXISTS(SELECT 1 FROM field_sources WHERE work_id=? AND field='media.coverDisabled'),EXISTS(SELECT 1 FROM field_sources WHERE work_id=? AND field='media.extractedPreviews')`, workID, workID).Scan(&disabled, &previews); err != nil {
		return err
	}
	var chosen mediaorder.Cover
	if !disabled {
		rows, err := t.query("SELECT media_id,filesystem_media_type,filesystem_file_name,relative_path FROM media WHERE work_id=?", workID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var c mediaorder.Cover
			if err = rows.Scan(&c.ID, &c.Kind, &c.Name, &c.Relative); err != nil {
				rows.Close()
				return err
			}
			if mediaorder.Better(c, chosen, previews) {
				chosen = c
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	return storeCover(t, workID, chosen)
}

func storeCover(t *transaction, workID int64, chosen mediaorder.Cover) error {
	var coverID any
	if chosen.ID != 0 {
		coverID = chosen.ID
	}
	return t.exec("UPDATE works SET cover_media_id=? WHERE work_id=?", coverID, workID)
}
