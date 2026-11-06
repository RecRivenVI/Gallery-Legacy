package metadata

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func platformExtras(r *Result, m Object, platform, author, work string) {
	switch platform {
	case "pixiv":
		pixivExtras(r, m)
	case "pixivFANBOX":
		fanboxExtras(r, m)
	case "Gank":
		gankExtras(r, m)
	case "Fantia":
		fantiaExtras(r, m)
	case "Patreon":
		patreonExtras(r, m)
	case "Pawchive":
		pawchiveExtras(r, m, author, work)
	case "X", "微博":
		socialExtras(r, m, platform)
	case "Venera":
		if len(m) > 0 {
			r.Warnings++
		}
	default:
		r.Valid = false
		r.Reason = "unknown_platform"
	}
}

func pixivExtras(r *Result, m Object) {
	r.Profile["avatarUrl"] = HTTP(Get(m, "user.profile_image_urls.medium"))
	r.body(m, []string{"caption", "text"}, []string{"html", "plain"})
	a := []any{}
	for _, v := range Arr(m["tags"], false) {
		if _, ok := v.(string); ok {
			a = append(a, v)
		} else {
			a = append(a, Get(Obj(v), "name"))
		}
	}
	r.tags(a)
	if n := Integer(m["illust_ai_type"], true); n != nil {
		r.Flags["aiGenerated"] = n == int64(2)
	}
	v := m["x_restrict"]
	if v == nil {
		v = m["restrict"]
	}
	if n := Integer(v, true); n != nil {
		r.Flags["adult"] = n.(int64) > 0
	}
	r.metric(m, "bookmarks", "total_bookmarks")
	r.metric(m, "comments", "total_comments")
	r.metric(m, "views", "total_view")

}

func fanboxExtras(r *Result, m Object) {
	r.Profile["avatarUrl"] = HTTP(Get(m, "user.iconUrl"))
	r.Profile["bannerUrl"] = HTTP(Get(m, "user.coverImageUrl"))
	links := []any{}
	for _, v := range Arr(Get(m, "user.profileLinks"), false) {
		if u := HTTP(v); u != nil {
			links = append(links, u)
		}
	}
	r.Profile["profileLinks"] = links
	r.Flags["adult"] = Bool(m["hasAdultContent"])
	r.Flags["restricted"] = Bool(m["isRestricted"])
	if n := Integer(m["feeRequired"], true); n != nil {
		r.Flags["paid"] = n.(int64) > 0
	}
	r.metric(m, "likes", "likeCount")
	r.metric(m, "comments", "commentCount")
	r.tags(Arr(m["tags"], false))
	r.body(m, []string{"content", "text", "excerpt"}, []string{"plain", "plain", "plain"})
	if s, ok := m["excerpt"].(string); ok && (r.Primary == nil || r.Primary.SourcePath != "excerpt") {
		r.Supplementary = append(r.Supplementary, Text{"summary", "excerpt", "plain", s})
	}
	for i, v := range Arr(Get(m, "articleBody.blocks"), false) {
		if s, ok := Obj(v)["text"].(string); ok {
			r.Supplementary = append(r.Supplementary, Text{"body_fragment", fmt.Sprintf("articleBody.blocks[%d].text", i), "plain", s})
		}
	}

}

func gankExtras(r *Result, m Object) {
	r.Profile["handle"] = r.Profile["displayName"]
	for _, e := range r.Evidence {
		if e.Field == "authorProfile.displayName" {
			e.Field = "authorProfile.handle"
			r.Evidence = append(r.Evidence, e)
			break
		}
	}

	if m["category"] == "ganknow" {
		link := megaLinkPattern
		for _, key := range []string{"content", "links"} {
			found := link.MatchString(String(m[key]))
			for _, v := range Arr(m[key], false) {
				found = found || link.MatchString(String(v))
			}
			if found {
				r.Evidence = append(r.Evidence, Evidence{"media.extractedPreviews", "metadata", "$." + key, 1})
				break
			}
		}
	}
	r.Profile["avatarUrl"] = HTTP(Or(Get(m, "user.avatar"), Get(m, "authorUser.avatar")))
	r.Profile["verified"] = Bool(Get(m, "user.verified"))
	r.body(m, []string{"content"}, []string{"plain"})
	a := Arr(m["tags"], false)
	for _, v := range Arr(m["postTags"], false) {
		a = append(a, Obj(v)["name"])
	}
	r.tags(a)

	for k, p := range map[string]string{"likes": "count_like", "comments": "count_comment", "reposts": "count_share", "bookmarks": "count_bookmark"} {
		r.metric(m, k, "postSummary."+p)
	}
	if v, exists := m["isAllowToSee"]; exists {
		r.Flags["restricted"] = v != true
	}
}

func fantiaExtras(r *Result, m Object) {
	r.Profile["profileUrl"] = HTTP(m["fanclub_url"])
	for _, path := range []string{"blogpost_text", "comment"} {
		if s, ok := m[path].(string); ok && s != "" {
			r.body(m, []string{path}, []string{"plain"})
			break
		}
	}
	if s, ok := m["comment"].(string); ok && s != "" && (r.Primary == nil || r.Primary.SourcePath != "comment") {
		r.Supplementary = append(r.Supplementary, Text{"summary", "comment", "plain", s})
	}
	if s, ok := m["content_comment"].(string); ok && s != "" {
		encoding := "opaque_text"
		var parsed any
		var hint any
		if json.Unmarshal([]byte(s), &parsed) == nil {
			encoding = "json_text"
			if _, ok := Obj(parsed)["ops"].([]any); ok {
				hint = "quill_delta_like"
			}
		}
		r.Structured = append(r.Structured, Object{"role": "body_source", "source_path": "content_comment", "encoding": encoding, "source_text": s, "schema_hint": hint})
		r.Evidence = append(r.Evidence, Evidence{"structuredSources.contentComment", "metadata", "$.content_comment", 1})
	}
	r.tags(Arr(m["tags"], false))
	if p := Integer(Get(m, "plan.price"), true); p != nil {
		r.Flags["paid"] = p.(int64) > 0
	}
	if s, ok := m["rating"].(string); ok {
		r.Flags["adult"] = adultRatingPattern.MatchString(s)
	}

}

func patreonExtras(r *Result, m Object) {
	r.Profile["avatarUrl"] = HTTP(Or(Get(m, "creator.image_url"), Get(m, "creator.thumb_url")))
	r.Profile["profileUrl"] = HTTP(Or(Get(m, "creator.url"), Get(m, "campaign.url")))
	links := []any{}
	social := Obj(Get(m, "creator.social_connections"))
	for _, k := range Keys(social) {
		v := social[k]
		if _, ok := v.(string); !ok {
			v = Obj(v)["url"]
		}
		if u := HTTP(v); u != nil {
			links = append(links, u)
		}
	}
	r.Profile["profileLinks"] = links
	r.body(m, []string{"content"}, []string{"html"})
	r.tags(Arr(m["tags"], false))
	r.Flags["paid"] = Bool(m["is_paid"])
	r.Flags["sensitive"] = Bool(Get(m, "campaign.is_nsfw"))
	r.field(m, r.Access, "currentUserCanView", "work.access.currentUserCanView", Bool, "current_user_can_view")
	r.field(m, r.Access, "minimumCentsPledgedToView", "work.access.minimumCentsPledgedToView", func(v any) any { return Integer(v, false) }, "min_cents_pledged_to_view")
	r.metric(m, "likes", "like_count")
	r.metric(m, "comments", "comment_count")

}

func pawchiveExtras(r *Result, m Object, author, work string) {
	pawchive(r, m, author, work)

	r.Flags["hasFull"] = Bool(m["has_full"])
	r.body(m, []string{"content", "description", "text"}, []string{"html", "html", "plain"})
	r.tags(Arr(m["tags"], false))
}

func socialExtras(r *Result, m Object, platform string) {
	if platform == "X" {

		r.body(m, []string{"content"}, []string{"plain"})
		r.tags(Arr(m["hashtags"], false))
		r.Flags["sensitive"] = Bool(m["sensitive"])
		for k, p := range map[string]string{"likes": "favorite_count", "replies": "reply_count", "reposts": "retweet_count", "views": "view_count", "bookmarks": "bookmark_count"} {
			r.metric(m, k, p)
		}
		for k, p := range map[string]string{"reply": "reply_id", "retweet": "retweet_id", "quote": "quoted_id", "conversation": "conversation_id"} {
			if x := ID(m[p]); x != nil && x != "0" && (k != "conversation" || x != r.Work["sourceWorkId"]) {
				r.Relations = append(r.Relations, Relation{k, String(x)})
				r.Evidence = append(r.Evidence, Evidence{"relations." + k, "metadata", "$." + p, 1})
			}
		}
	} else {

		r.body(m, []string{"longText.content", "text_raw", "text"}, []string{"html", "plain", "html"})
		if r.Primary != nil && (m["isMarkdown"] == true || Get(m, "longText.isMarkdown") == true && r.Primary.SourcePath == "longText.content") {
			r.Primary.SourceFormat = "markdown"
		}
		a := []any{}
		for _, v := range Arr(m["topic_struct"], true) {
			a = append(a, Obj(v)["topic_title"])
		}
		if r.Primary != nil {
			for _, match := range topicPattern.FindAllStringSubmatch(r.Primary.SourceText, -1) {
				a = append(a, match[1])
			}
		}
		r.tags(a)
		ad := m["isAd"]
		if ad == json.Number("0") {
			ad = false
		}
		if ad == json.Number("1") {
			ad = true
		}
		r.Flags["advertisement"] = Bool(ad)
		r.metric(m, "likes", "attitudes_count")
		r.metric(m, "comments", "comments_count")
		r.metric(m, "reposts", "reposts_count")
		r.field(m, Object{}, "repost", "relations.repost", ID, "retweeted_status.idstr", "retweeted_status.mid", "retweeted_status.id")
		for _, p := range []string{"retweeted_status.idstr", "retweeted_status.mid", "retweeted_status.id"} {
			if x := ID(Get(m, p)); x != nil {
				r.Relations = append(r.Relations, Relation{"repost", String(x)})
				break
			}
		}
	}
	if t, ok := r.Work["publishedAtMs"].(int64); ok {
		r.Work["title"] = time.UnixMilli(t).UTC().Format("2006-01-02T15:04:05.000Z")
		p := "date"
		for _, e := range r.Evidence {
			if e.Field == "work.publishedAtMs" {
				p = strings.TrimPrefix(e.Path, "$.")
			}
		}
		r.Evidence = append(r.Evidence, Evidence{"work.title", "metadata", "$." + p, 1})
	}
	r.field(m, r.Work, "language", "work.language", Str, "lang")
	socialProfile(r, m, platform)
}
