package reading

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
)

func (v *View) filterConditions(q protocol.Query) ([]string, []any, error) {
	c := []string{}
	args := []any{}
	f := q.Filters
	for _, key := range []string{"types", "ratings"} {
		if value := f.Get(key); value != "" {
			if !v.enriched {
				c = append(c, "0")
				continue
			}
			column := "work_type"
			if key == "ratings" {
				column = "cast(rating AS TEXT)"
				c = append(c, "s.platform_id='pixiv'")
			}
			raw, _ := json.Marshal(strings.Split(value, ","))
			c = append(c, "s.work_id IN (SELECT work_id FROM work_details WHERE "+column+" IN (SELECT value FROM json_each(?)))")
			args = append(args, string(raw))
		}
	}
	for _, pair := range []struct{ Key, Column string }{{"ai", "is_ai_generated"}, {"paid", "is_paid"}} {
		if value := f.Get(pair.Key); value == "0" || value == "1" {
			c = append(c, "coalesce(w."+pair.Column+",0)=?")
			args = append(args, value)
			if pair.Key == "ai" {
				c = append(c, "s.platform_id='pixiv'")
			}
		}
	}
	if value := f.Get("from"); value != "" {
		date, _ := time.Parse("2006-01-02", value)
		c = append(c, "w.published_at_ms>=?")
		args = append(args, date.UnixMilli())
	}
	if value := f.Get("to"); value != "" {
		date, _ := time.Parse("2006-01-02", value)
		c = append(c, "w.published_at_ms<?")
		args = append(args, date.AddDate(0, 0, 1).UnixMilli())
	}
	if value := f.Get("pages"); value == "single" {
		c = append(c, visibleCountSQL("w")+"=1")
	} else if value == "multi" {
		c = append(c, visibleCountSQL("w")+">1")
	}
	if value := f.Get("series"); value != "" && v.enriched {
		c = append(c, "s.work_id IN (SELECT work_id FROM work_details WHERE series_id=?)")
		args = append(args, value)
	}
	if value := f.Get("linkedAuthor"); value != "" {
		ids, err := v.linkedIDs(value)
		if err != nil {
			return nil, nil, err
		}
		raw, _ := json.Marshal(ids)
		c = append(c, "s.author_id IN (SELECT value FROM json_each(?))")
		args = append(args, string(raw))
	}
	tests := []string{}
	personalArgs := []any{}
	if f.Get("favorite") == "1" || f.Get("my") == "favorites" {
		tests = append(tests, "p.favorite_at>0")
	}
	if f.Get("hideRead") == "1" {
		tests = append(tests, "coalesce(p.read_at,0)=0")
	}
	if f.Get("minRating") != "" && f.Get("minRating") != "0" {
		tests = append(tests, "p.rating>=?")
		personalArgs = append(personalArgs, f.Get("minRating"))
	}
	if f.Get("my") == "history" {
		tests = append(tests, "p.read_at>0")
	}
	if f.Get("my") == "continue" {
		tests = append(tests, "p.read_at>0 AND p.page>0 AND p.page<"+visibleCountSQL("aw")+"")
	}
	if len(tests) > 0 {
		if !v.personal || v.accountID == "" {
			c = append(c, "0")
		} else {
			predicate := strings.Join(tests, " AND ")
			test := "s.work_id IN (SELECT aw.work_id FROM personal.work_state p JOIN works aw ON aw.platform_id=p.platform AND aw.relative_path_key=p.relative_key WHERE p.account_id=? AND " + predicate + ")"
			if f.Get("hideRead") == "1" && len(tests) == 1 {
				test = "s.work_id NOT IN (SELECT aw.work_id FROM personal.work_state p JOIN works aw ON aw.platform_id=p.platform AND aw.relative_path_key=p.relative_key WHERE p.account_id=? AND p.read_at>0)"
			}
			c = append(c, test)
			args = append(args, v.accountID)
			args = append(args, personalArgs...)
		}
	}
	if value := f.Get("collection"); value != "" {
		if !v.personal || v.accountID == "" {
			c = append(c, "0")
		} else {
			c = append(c, "s.work_id IN (SELECT aw.work_id FROM personal.collection_works cw JOIN personal.collections cc ON cc.id=cw.collection_id JOIN works aw ON aw.platform_id=cw.platform AND aw.relative_path_key=cw.relative_key WHERE cc.account_id=? AND cw.collection_id=?)")
			args = append(args, v.accountID, value)
		}
	}

	return c, args, nil
}
