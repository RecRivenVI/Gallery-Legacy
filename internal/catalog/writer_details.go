package catalog

import "github.com/RecRivenVI/Gallery-Legacy/internal/metadata"

func writeDetails(t *transaction, p PreparedWork, workID int64) error {
	d := p.Normalized.Details
	return t.exec(`INSERT INTO work_details VALUES (?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET work_type=excluded.work_type,rating=excluded.rating,series_id=excluded.series_id,details_json=excluded.details_json`, workID, d.WorkType, d.Rating, d.SeriesID, metadata.JSON(d))
}

func writeAuthorKeys(t *transaction, p PreparedWork, authorID int64) error {
	if err := t.exec("DELETE FROM author_keys WHERE author_id=?", authorID); err != nil {
		return err
	}
	for _, link := range p.Normalized.AuthorLinks {
		if err := t.exec("INSERT OR IGNORE INTO author_keys VALUES (?,?,?)", authorID, link.Platform, link.SourceID); err != nil {
			return err
		}
	}
	return nil
}
