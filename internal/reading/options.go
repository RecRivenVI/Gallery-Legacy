package reading

import (
	"encoding/json"
	"net/url"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
)

func (v *View) FilterOptions(params url.Values) (api.AvailableFilters, error) {
	result := api.AvailableFilters{WorkTypes: []string{}, Metrics: []string{}}
	q, err := protocol.ParseQuery(params, "tags", v.epoch, nil)
	if err != nil {
		return result, err
	}
	conditions := []string{}
	args := []any{}
	if len(q.Platforms) > 0 {
		raw, _ := json.Marshal(q.Platforms)
		conditions = append(conditions, "w.platform_id IN (SELECT value FROM json_each(?))")
		args = append(args, string(raw))
	} else if q.PlatformID != nil {
		conditions = append(conditions, "w.platform_id=?")
		args = append(args, *q.PlatformID)
	}
	if v.enriched {
		rows, err := v.rows("SELECT DISTINCT d.work_type FROM works w JOIN work_details d USING(work_id)"+where(conditions), args...)
		if err != nil {
			return result, err
		}
		for _, r := range rows {
			if t := text(r["work_type"]); t != "" {
				result.WorkTypes = append(result.WorkTypes, t)
			}
		}
	}
	counts, err := v.row("SELECT coalesce(sum(w.platform_id='pixiv'),0) pixiv,coalesce(sum(w.platform_id IN('pixivFANBOX','Fantia','Patreon')),0) paid FROM works w"+where(conditions), args...)
	if err != nil {
		return result, err
	}
	result.Pixiv = counts["pixiv"].(int64) > 0
	result.Paid = counts["paid"].(int64) > 0
	if len(q.Platforms) > 1 {
		for _, p := range q.Platforms {
			if p != "pixivFANBOX" && p != "Fantia" && p != "Patreon" {
				result.Paid = false
			}
		}
	}
	if len(q.Platforms) < 2 {
		for _, metric := range []string{"bookmarks", "views", "likes"} {
			row, err := v.row("SELECT 1 FROM work_metrics m JOIN works w USING(work_id)"+where(append(append([]string{}, conditions...), "m."+metric+" IS NOT NULL"))+" LIMIT 1", args...)
			if err != nil {
				return result, err
			}
			if row != nil {
				result.Metrics = append(result.Metrics, metric)
			}
		}
	}
	return result, nil
}
