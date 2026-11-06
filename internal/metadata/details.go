package metadata

import "github.com/RecRivenVI/Gallery-Legacy/api"

type Episode = api.Episode
type AuthorLink = api.AuthorLink
type Details = api.WorkDetails

var detailPaths = map[string]struct{ kind, seriesID, seriesTitle, planName, planFee, region string }{
	"pixiv":       {kind: "type", seriesID: "series.id", seriesTitle: "series.title"},
	"pixivFANBOX": {kind: "type", planName: "plan.title", planFee: "plan.fee|feeRequired"},
	"Fantia":      {kind: "content_category", planName: "plan.name", planFee: "plan.price"},
	"Patreon":     {kind: "post_type"},
	"微博":          {kind: "page_info.object_type", region: "region_name"},
}

func optionalInteger(value any) *int64 {
	if n, ok := Integer(value, true).(int64); ok {
		return &n
	}
	return nil
}

func detailValue(m Object, candidates string) any {
	for _, path := range paths(candidates) {
		if value := Get(m, path); value != nil {
			return value
		}
	}
	return nil
}

func parseDetails(r *Result, m Object, platform string) {
	f := detailPaths[platform]
	r.Details = Details{WorkType: String(detailValue(m, f.kind)), SeriesID: String(ID(detailValue(m, f.seriesID))), SeriesTitle: String(detailValue(m, f.seriesTitle)), PlanName: String(detailValue(m, f.planName)), PlanFee: optionalInteger(detailValue(m, f.planFee)), Region: String(detailValue(m, f.region)), Tools: []string{}}
	if platform == "Venera" {
		r.Details.WorkType = "manga"
	}
	if platform == "pixiv" {
		n := optionalInteger(m["x_restrict"])
		if n != nil && *n >= 0 && *n <= 2 {
			r.Details.Rating = n
		}
		for _, value := range Arr(m["tools"], false) {
			if text := String(value); text != "" {
				r.Details.Tools = append(r.Details.Tools, text)
			}
		}
	}
	if platform == "pixivFANBOX" {
		r.Details.Previous = episode(m["prevPost"])
		r.Details.Next = episode(m["nextPost"])
		if id := String(ID(Get(m, "user.userId"))); id != "" {
			r.AuthorLinks = append(r.AuthorLinks, AuthorLink{Platform: "pixiv", SourceID: id})
		}
	}

	if platform == "Pawchive" {
		r.Details.OriginalService = String(m["service"])
		r.Details.OriginalUser = String(ID(m["user"]))
		r.Details.OriginalPost = String(ID(m["id"]))
	}
}

func episode(value any) *Episode {
	m := Obj(value)
	id := String(ID(m["id"]))
	if id == "" {
		return nil
	}
	e := &Episode{ID: id, Title: String(m["title"])}
	if time, ok := Timestamp(Or(m["publishedDatetime"], m["published_at"], m["date"])).(int64); ok {
		e.PublishedAtMS = &time
	}
	return e
}
