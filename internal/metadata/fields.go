package metadata

import "strings"

type fieldMap struct {
	workIDs, authorIDs                           string
	title, published, updated, name, handle, bio string
}

// Priority is left to right. These are the fixed downloader fields, not a
// configurable rule language; compound formats stay in named parsing functions.
var platformFields = map[string]fieldMap{
	"pixiv":       {"id", "user.id", "title.text|title", "date|create_date", "", "user.name", "user.account", ""},
	"pixivFANBOX": {"id", "user.userId|user.creatorId|creatorId", "title", "publishedDatetime|date", "updatedDatetime", "user.name|user.creatorId", "user.creatorId", "user.description"},
	"Gank":        {"id|post_id", "user.id|author|authorUser.id", "title", "createdAt|date", "updatedAt|date_updated", "user.nickname|authorUser.nickname", "", "user.profile.description|user.description"},
	"Fantia":      {"post_id|content_id", "fanclub_user_id", "post_title|content_title", "posted_at|date", "", "fanclub_user_name|fanclub_name", "fanclub_name", ""},
	"Patreon":     {"id", "creator.id", "title", "published_at|date", "", "creator.full_name|creator.first_name|campaign.name", "creator.vanity", "creator.about"},
	"Pawchive":    {"", "", "title", "published|date|added", "edited", "user_profile.name|username|user_name|creator|artist", "user_profile.public_id|username", ""},
	"X":           {"tweet_id|id", "user.id|author.id", "", "date", "", "user.name|author.name", "user.nick|author.nick", "user.description|author.description"},
	"微博":          {"idstr|mid|id", "user.idstr|user.id", "", "date|created_at", "", "user.screen_name", "user.domain|user.weihao", "user.description"},
	"Venera":      {},
}

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
	for _, item := range []struct {
		target            Object
		key, field, paths string
		decode            func(any) any
	}{
		{r.Work, "title", "work.title", f.title, Str},
		{r.Work, "publishedAtMs", "work.publishedAtMs", f.published, Timestamp},
		{r.Work, "updatedAtMs", "work.updatedAtMs", f.updated, Timestamp},
		{r.Profile, "displayName", "authorProfile.displayName", f.name, Str},
		{r.Profile, "handle", "authorProfile.handle", f.handle, Str},
		{r.Profile, "bio", "authorProfile.bio", f.bio, Str},
	} {
		r.field(m, item.target, item.key, item.field, item.decode, paths(item.paths)...)
	}
}
