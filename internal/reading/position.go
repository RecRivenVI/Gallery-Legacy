package reading

import "github.com/RecRivenVI/Gallery-Legacy/internal/protocol"

func (v *View) Position(path string, pageSize int64) (Row, error) {
	platform, key, ok := parsePath(path)
	if !ok {
		return nil, nil
	}
	work, err := v.row("SELECT w.work_id,w.author_id,w.sort_at_ms,a.relative_path author_path FROM works w JOIN authors a USING(author_id) WHERE w.platform_id=? AND w.relative_path_key=?", platform, key)
	if err != nil || work == nil {
		return nil, err
	}
	details, err := v.workDetails(work["work_id"].(int64))
	if err != nil {
		return nil, err
	}
	from := "works w"
	conditions := []string{"w.platform_id=?"}
	args := []any{platform}
	browse := publicPath(platform, text(work["author_path"]))
	if details.SeriesID != "" {
		from += " JOIN work_details d USING(work_id)"
		conditions = append(conditions, "d.series_id=?")
		args = append(args, details.SeriesID)
		browse = "/@all/" + protocol.Component(platform)
	} else {
		conditions = append(conditions, "w.author_id=?")
		args = append(args, work["author_id"])
	}
	conditions = append(conditions, "(w.sort_at_ms<? OR (w.sort_at_ms=? AND w.work_id<?))")
	args = append(args, work["sort_at_ms"], work["sort_at_ms"], work["work_id"])
	rank, err := v.count(from, conditions, args)
	if err != nil {
		return nil, err
	}
	return Row{"path": browse, "page": rank/pageSize + 1, "seriesId": details.SeriesID}, nil
}
