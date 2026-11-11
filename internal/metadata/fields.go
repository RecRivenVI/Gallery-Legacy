package metadata

import (
	"strings"
	"time"
)

type fieldMap struct {
	workIDs, authorIDs                           string
	title, published, updated, name, handle, bio string
}

// Priority is left to right. These are the fixed downloader fields, not a
// configurable rule language; compound formats stay in named parsing functions.
var platformFields = map[string]fieldMap{
	"pixiv":       {"id", "user.id", "title.text|title", "date|create_date", "", "user.name", "user.account", ""},
	"pixivFANBOX": {"id", "user.userId|user.creatorId|creatorId", "title", "date|publishedDatetime", "updatedDatetime", "user.name|user.creatorId", "user.creatorId", "user.description"},
	"Gank":        {"id|post_id", "user.id|author|authorUser.id", "title", "date|createdAt", "updatedAt|date_updated", "user.nickname|authorUser.nickname", "", "user.profile.description|user.description"},
	"Fantia":      {"post_id|content_id", "fanclub_user_id", "post_title|content_title", "date|posted_at", "", "fanclub_user_name|fanclub_name", "fanclub_name", ""},
	"Patreon":     {"id", "creator.id", "title", "date|published_at", "", "creator.full_name|creator.first_name|campaign.name", "creator.vanity", "creator.about"},
	"Pawchive":    {"", "", "title", "date|published", "edited", "user_profile.name|username|user_name|creator|artist", "user_profile.public_id|username", ""},
	"X":           {"tweet_id|id", "user.id|author.id", "title", "date", "", "user.name|author.name", "user.nick|author.nick", "user.description|author.description"},
	"微博":          {"idstr|mid|id", "user.idstr|user.id", "title", "date|created_at", "", "user.screen_name", "user.domain|user.weihao", "user.description"},
	"Venera":      {},
}

var japanTime = time.FixedZone("JST", 9*60*60)

func paths(value string) []string {
	if value == "" {
		return nil
	}
	return strings.Split(value, "|")
}

func applyFields(r *Result, m Object, platform, author, work string) {
	f, ok := platformFields[platform]
	if !ok {
		return
	}
	if platform != "Pawchive" && platform != "Venera" {
		r.identity(m, author, work, paths(f.workIDs), paths(f.authorIDs))
	}
	postTime := Timestamp
	if platform == "Pawchive" && pawchiveService(m, author) == "fanbox" {
		postTime = func(v any) any { return timestamp(v, japanTime) }
	}
	for _, item := range []struct {
		target            Object
		key, field, paths string
		decode            func(any) any
	}{
		{r.Work, "title", "work.title", f.title, Str},
		{r.Work, "publishedAtMs", "work.publishedAtMs", f.published, postTime},
		{r.Work, "updatedAtMs", "work.updatedAtMs", f.updated, postTime},
		{r.Profile, "displayName", "authorProfile.displayName", f.name, Str},
		{r.Profile, "handle", "authorProfile.handle", f.handle, Str},
		{r.Profile, "bio", "authorProfile.bio", f.bio, Str},
	} {
		r.field(m, item.target, item.key, item.field, item.decode, paths(item.paths)...)
	}
}
