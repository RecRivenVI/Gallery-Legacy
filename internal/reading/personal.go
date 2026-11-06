package reading

import "context"

func visibleCountSQL(alias string) string {
	return "(SELECT count(*) FROM media vm WHERE vm.work_id=" + alias + ".work_id AND gallery_visible_media(vm.filesystem_file_name,EXISTS(SELECT 1 FROM field_sources fs WHERE fs.work_id=" + alias + ".work_id AND fs.field='media.extractedPreviews'))=1)"
}

type accountKey struct{}

func WithAccount(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, accountKey{}, id)
}

func (v *View) PersonalCounts() (map[string]int64, error) {
	result := map[string]int64{"favorites": 0, "history": 0, "continue": 0}
	if !v.personal || v.accountID == "" {
		return result, nil
	}
	row, err := v.row(`SELECT coalesce(sum(p.favorite_at>0),0) favorites,coalesce(sum(p.read_at>0),0) history,coalesce(sum(CASE WHEN p.read_at>0 AND p.page>0 THEN p.page<`+visibleCountSQL("w")+` ELSE 0 END),0) continuation FROM personal.work_state p JOIN works w ON w.platform_id=p.platform AND w.relative_path_key=p.relative_key WHERE p.account_id=?`, v.accountID)
	if err != nil {
		return nil, err
	}
	result["favorites"] = row["favorites"].(int64)
	result["history"] = row["history"].(int64)
	result["continue"] = row["continuation"].(int64)
	return result, nil
}

func (v *View) personalState(workID int64) (Row, error) {
	if !v.personal || v.accountID == "" {
		return nil, nil
	}
	row, err := v.row(`SELECT p.favorite_at,p.rating,p.page,p.read_at,p.reading_mode,p.rtl,p.cover_alone FROM works w JOIN personal.work_state p ON p.platform=w.platform_id AND p.relative_key=w.relative_path_key WHERE w.work_id=? AND p.account_id=?`, workID, v.accountID)
	if err != nil {
		return nil, err
	}
	result := Row{"favorite": false, "rating": 0, "page": 0, "readAt": 0, "readingMode": "", "rtl": false, "coverAlone": true, "tags": []string{}, "collections": []string{}}
	if row != nil {
		result["favorite"] = row["favorite_at"].(int64) > 0
		result["rating"] = row["rating"]
		result["page"] = row["page"]
		result["readAt"] = row["read_at"]
		result["readingMode"] = row["reading_mode"]
		result["rtl"] = row["rtl"] == int64(1)
		result["coverAlone"] = row["cover_alone"] == int64(1)
		if row["page"].(int64) > 0 {
			count, err := v.row("SELECT "+visibleCountSQL("w")+" n FROM works w WHERE w.work_id=?", workID)
			if err != nil {
				return nil, err
			}
			result["totalPages"] = count["n"]
		}
	}
	rows, err := v.rows(`SELECT pt.label FROM works w JOIN personal.work_tags pt ON pt.platform=w.platform_id AND pt.relative_key=w.relative_path_key WHERE w.work_id=? AND pt.account_id=? ORDER BY pt.normalized`, workID, v.accountID)
	if err != nil {
		return nil, err
	}
	tags := []string{}
	for _, t := range rows {
		tags = append(tags, text(t["label"]))
	}
	result["tags"] = tags
	rows, err = v.rows(`SELECT cw.collection_id FROM works w JOIN personal.collection_works cw ON cw.platform=w.platform_id AND cw.relative_key=w.relative_path_key JOIN personal.collections c ON c.id=cw.collection_id WHERE w.work_id=? AND c.account_id=? ORDER BY c.name`, workID, v.accountID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, r := range rows {
		ids = append(ids, text(r["collection_id"]))
	}
	result["collections"] = ids
	return result, nil
}
