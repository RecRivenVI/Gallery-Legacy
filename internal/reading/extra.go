package reading

import "github.com/RecRivenVI/Gallery-Legacy/api"

func (v *View) workExtras(workID int64, item Row) error {
	sources, err := v.rows("SELECT source_text FROM work_text_sources WHERE work_id=? AND role='source_link' AND source_format='plain' ORDER BY ordinal", workID)
	if err != nil {
		return err
	}
	links := []api.SourceLink{}
	for _, source := range sources {
		if url := text(source["source_text"]); url != "" {
			links = append(links, api.SourceLink{URL: url, Label: url})
		}
	}
	item["links"] = links
	rows, err := v.rows(`SELECT r.relation_type,r.target_platform_id,r.target_source_work_id,w.relative_path FROM social_relations r LEFT JOIN works w ON w.work_id=r.target_work_id WHERE r.work_id=? ORDER BY r.ordinal`, workID)
	if err != nil {
		return err
	}
	relations := []api.WorkRelation{}
	for _, row := range rows {
		path := ""
		if row["relative_path"] != nil {
			path = publicPath(text(row["target_platform_id"]), text(row["relative_path"]))
		}
		relations = append(relations, api.WorkRelation{Type: text(row["relation_type"]), TargetPlatform: text(row["target_platform_id"]), TargetID: text(row["target_source_work_id"]), TargetPath: path})
	}
	item["relations"] = relations
	return nil
}
