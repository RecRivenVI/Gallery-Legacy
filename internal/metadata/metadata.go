// Package metadata contains explicit adapters for the nine fixed platforms.
// It is pure parsing: no filesystem, network, or database access.
package metadata

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Object = map[string]any
type Text struct{ Role, SourcePath, SourceFormat, SourceText string }
type Declaration struct {
	SourceID, Kind, Name, URL, Hash any
	Size, Duration                  any
	References                      []Reference
}
type Reference struct{ Kind, Value, SourcePath string }
type Relation struct{ Type, SourceID string }
type Evidence struct {
	Field, Kind, Path string
	Priority          int
}
type Result struct {
	platform                              string
	Valid                                 bool
	Reason                                string
	Work, Profile, Flags, Access, Metrics Object
	Tags                                  []string
	Primary                               *Text
	Supplementary                         []Text
	Structured                            []Object
	Declarations                          []Declaration
	Relations                             []Relation
	Evidence                              []Evidence
	Warnings                              int
	InvalidFields                         int
}

var Versions = map[string]int{"pixiv": 3, "pixivFANBOX": 3, "Gank": 4, "Fantia": 3, "Patreon": 3, "Pawchive": 4, "X": 3, "微博": 3, "Venera": 1}

func Get(m Object, path string) any {
	var v any = m
	for _, p := range strings.Split(path, ".") {
		o, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = o[p]
	}
	return v
}
func Str(v any) any {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	return s
}
func String(v any) string { s, _ := v.(string); return s }
func ID(v any) any {
	if s, ok := v.(string); ok {
		if s != "" {
			return s
		}
		return nil
	}
	if n, ok := v.(json.Number); ok {
		f, e := n.Float64()
		if e == nil && math.Abs(f) <= 9007199254740991 && math.Trunc(f) == f {
			return strconv.FormatInt(int64(f), 10)
		}
	}
	return nil
}
func Integer(v any, allowString bool) any {
	var s string
	switch n := v.(type) {
	case json.Number:
		s = string(n)
	case string:
		if !allowString {
			return nil
		}
		if !regexp.MustCompile(`^-?\d+$`).MatchString(n) {
			return nil
		}
		s = n
	default:
		return nil
	}
	f, e := strconv.ParseFloat(s, 64)
	if e != nil || math.Abs(f) > 9007199254740991 || math.Trunc(f) != f {
		return nil
	}
	return int64(f)
}
func Bool(v any) any {
	b, ok := v.(bool)
	if !ok {
		return nil
	}
	return b
}
func HTTP(v any) any {
	s, ok := v.(string)
	if !ok || s == "" || !regexp.MustCompile(`(?i)^https?://`).MatchString(s) {
		return nil
	}
	return s
}
func Arr(v any, single bool) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	if single {
		if _, ok := v.(map[string]any); ok {
			return []any{v}
		}
	}
	return nil
}
func Keys(v any) []string {
	m, _ := v.(map[string]any)
	a := []string{}
	for k := range m {
		a = append(a, k)
	}
	sort.Strings(a)
	return a
}
func Obj(v any) Object {
	o, _ := v.(map[string]any)
	if o == nil {
		return Object{}
	}
	return o
}
func Or(v ...any) any {
	for _, x := range v {
		if x != nil && x != "" && x != false && x != json.Number("0") {
			return x
		}
	}
	return nil
}
func Timestamp(v any) any {
	if _, ok := v.(json.Number); ok {
		return Integer(v, false)
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	s = strings.TrimSpace(s)
	if !regexp.MustCompile(`(?i)(Z|[+-]\d{2}:?\d{2})$`).MatchString(s) {
		s = strings.Replace(s, " ", "T", 1) + "Z"
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05-0700", "2006-01-02Z", "Mon Jan 02 15:04:05 -0700 2006"} {
		if t, e := time.Parse(layout, s); e == nil {
			return t.UnixMilli()
		}
	}
	// V8's existing Date.parse accepts a trailing isolated month in text.
	// Keep the current adapter result for public legacy structural fixtures.
	if match := regexp.MustCompile(`^[A-Za-z]+-(\d{1,2})Z$`).FindStringSubmatch(s); match != nil {
		n, _ := strconv.Atoi(match[1])
		if n >= 1 && n <= 12 {
			return time.Date(2001, time.Month(n), 1, 0, 0, 0, 0, time.UTC).UnixMilli()
		}
	}
	return nil
}
func New() Result {
	return Result{Valid: true, Work: Object{}, Profile: Object{"profileLinks": []any{}}, Flags: Object{}, Access: Object{}, Metrics: Object{}, Tags: []string{}, Declarations: []Declaration{}, Supplementary: []Text{}, Structured: []Object{}, Relations: []Relation{}, Evidence: []Evidence{}}
}
func (r *Result) field(m Object, group Object, key, field string, decode func(any) any, paths ...string) {
	for i, p := range paths {
		raw := Get(m, p)
		v := decode(raw)
		if raw != nil && raw != "" && v == nil {
			r.InvalidFields++
		}
		if v != nil && v != "" {
			group[key] = v
			r.Evidence = append(r.Evidence, Evidence{field, "metadata", "$." + p, i + 1})
			return
		}
	}
}
func (r *Result) body(m Object, paths, formats []string) {
	for i, p := range paths {
		v := Str(Get(m, p))
		if v != nil {
			r.Primary = &Text{"body", p, formats[i], String(v)}
			r.Evidence = append(r.Evidence, Evidence{"richText.primary", "metadata", "$." + p, i + 1})
			return
		}
	}
}
func (r *Result) tags(values []any) {
	seen := map[string]bool{}
	for _, v := range values {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" && !seen[s] {
			seen[s] = true
			r.Tags = append(r.Tags, s)
		}
	}
}
func (r *Result) metric(m Object, key, path string) { r.Metrics[key] = Integer(Get(m, path), true) }
func (r *Result) identity(m Object, author, work string, workPaths, authorPaths []string) {
	r.field(m, r.Work, "sourceWorkId", "work.sourceWorkId", ID, workPaths...)
	r.field(m, r.Profile, "sourceAuthorId", "authorProfile.sourceAuthorId", ID, authorPaths...)
	if r.Work["sourceWorkId"] == nil {
		if x := DirectoryWorkID(work); x != nil {
			r.Work["sourceWorkId"] = x
			r.Evidence = append(r.Evidence, Evidence{"work.sourceWorkId", "filesystem", "workDirectoryName.timestampedSuffix", len(workPaths) + 1})
		}
	}
	if r.Profile["sourceAuthorId"] == nil {
		if x := AuthorIDFor(r.platform, author); x != nil {
			r.Profile["sourceAuthorId"] = x
			r.Evidence = append(r.Evidence, Evidence{"authorProfile.sourceAuthorId", "filesystem", "authorDirectoryName", len(authorPaths) + 1})
		}
	}
}

var timestampName = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_(.+)$`)

func DirectoryWorkID(s string) any {
	m := timestampName.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	return m[5]
}
func DirectoryDate(s string) any {
	m := timestampName.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	return Timestamp(m[1] + "T" + m[2] + ":" + m[3] + ":" + m[4] + "Z")
}
func DirectoryAuthorID(s string) any {
	if regexp.MustCompile(`^\d+$`).MatchString(s) || regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(s) {
		return s
	}
	return nil
}
func AuthorIDFor(platform, s string) any {
	if platform == "Venera" {
		return nil
	}
	if platform == "Gank" {
		if regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(s) {
			return s
		}
		return nil
	}
	if platform == "Pawchive" {
		parts := strings.SplitN(s, "_", 2)
		if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
			return parts[0] + ":" + parts[1]
		}
		return nil
	}
	if regexp.MustCompile(`^\d+$`).MatchString(s) {
		return s
	}
	return nil
}
func SafeLink(v any) any {
	s, ok := v.(string)
	if !ok || len(s) > 8192 || strings.ContainsAny(s, " \t\r\n") {
		return nil
	}
	u, e := url.Parse(s)
	if e != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil
	}
	for k := range u.Query() {
		if regexp.MustCompile(`(?i)^(access_token|refresh_token|token|password|secret|cookie|authorization)$`).MatchString(k) {
			return nil
		}
	}
	return s
}
func Parse(platform, author, work string, raw []byte) (Result, Object) {
	r := New()
	r.platform = platform
	var value any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if e := d.Decode(&value); e != nil {
		r.Valid = false
		r.Reason = "malformed_json"
		r.identity(Object{}, author, work, nil, nil)
		return r, nil
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		r.Valid = false
		r.Reason = "malformed_json"
		return r, nil
	}
	m, ok := value.(map[string]any)
	if !ok {
		r.Valid = false
		r.Reason = "metadata_not_object"
		r.identity(Object{}, author, work, nil, nil)
		return r, nil
	}
	if platform != "Venera" {
		idPaths := map[string][]string{"pixiv": {"id", "user.id"}, "pixivFANBOX": {"id", "user.userId", "user.creatorId", "creatorId"}, "Gank": {"id", "post_id", "user.id", "author", "authorUser.id"}, "Fantia": {"post_id", "content_id", "file_id", "fanclub_user_id"}, "Patreon": {"id", "creator.id"}, "X": {"tweet_id", "id", "user.id", "author.id", "reply_id", "retweet_id", "quote_id", "conversation_id"}, "微博": {"id", "idstr", "user.id", "user.idstr"}}[platform]
		for _, path := range idPaths {
			v := Get(m, path)
			if v != nil && v != "" && ID(v) == nil {
				r.InvalidFields++
			}
		}
		for _, p := range []string{"postUrl", "post_url", "url", "sourceUrl", "source_url", "permalink", "link", "source.url"} {
			if v := SafeLink(Get(m, p)); v != nil {
				r.Work["sourceUrl"] = v
				r.Supplementary = append(r.Supplementary, Text{"source_link", "$." + p, "plain", String(v)})
				r.Evidence = append(r.Evidence, Evidence{"work.sourceUrl", "metadata", "$." + p, 1})
				break
			}
		}
	}
	title := func(p ...string) { r.field(m, r.Work, "title", "work.title", Str, p...) }
	date := func(p ...string) { r.field(m, r.Work, "publishedAtMs", "work.publishedAtMs", Timestamp, p...) }
	updated := func(p ...string) { r.field(m, r.Work, "updatedAtMs", "work.updatedAtMs", Timestamp, p...) }
	name := func(p ...string) { r.field(m, r.Profile, "displayName", "authorProfile.displayName", Str, p...) }
	handle := func(p ...string) { r.field(m, r.Profile, "handle", "authorProfile.handle", Str, p...) }
	bio := func(p ...string) { r.field(m, r.Profile, "bio", "authorProfile.bio", Str, p...) }
	switch platform {
	case "pixiv":
		r.identity(m, author, work, []string{"id"}, []string{"user.id"})
		title("title.text", "title")
		date("date", "create_date")
		name("user.name")
		handle("user.account")
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
		for _, v := range Arr(m["frames"], false) {
			o := Obj(v)
			r.Declarations = append(r.Declarations, Declaration{SourceID: Str(o["file"]), Kind: "animation_frame", Name: Str(o["file"]), Duration: Integer(o["delay"], true)})
		}
	case "pixivFANBOX":
		r.identity(m, author, work, []string{"id"}, []string{"user.userId", "user.creatorId", "creatorId"})
		title("title")
		date("publishedDatetime", "date")
		updated("updatedDatetime")
		name("user.name", "user.creatorId")
		handle("user.creatorId")
		bio("user.description")
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
		for _, v := range Arr(m["archives"], false) {
			o := Obj(v)
			r.Declarations = append(r.Declarations, Declaration{SourceID: ID(o["id"]), Kind: "archive", Name: Str(o["name"]), URL: HTTP(o["url"]), Size: Integer(o["size"], true)})
		}
		images := Obj(Get(m, "articleBody.imageMap"))
		for _, k := range Keys(images) {
			o := Obj(images[k])
			r.Declarations = append(r.Declarations, Declaration{SourceID: k, Kind: "image", URL: HTTP(Or(o["originalUrl"], o["url"]))})
		}
	case "Gank":
		r.identity(m, author, work, []string{"id", "post_id"}, []string{"user.id", "author", "authorUser.id"})
		title("title")
		date("createdAt", "date")
		updated("updatedAt", "date_updated")
		name("user.nickname", "authorUser.nickname")
		r.Profile["handle"] = r.Profile["displayName"]
		for _, e := range r.Evidence {
			if e.Field == "authorProfile.displayName" {
				e.Field = "authorProfile.handle"
				r.Evidence = append(r.Evidence, e)
				break
			}
		}
		bio("user.profile.description", "user.description")
		if m["category"] == "ganknow" {
			link := regexp.MustCompile(`(?i)https://mega(?:\.nz|\.co\.nz)/(?:file|folder)/`)
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
		for _, v := range Arr(m["postMedia"], false) {
			o := Obj(v)
			r.Declarations = append(r.Declarations, Declaration{SourceID: ID(o["id"]), Kind: Str(o["type"]), URL: HTTP(Or(o["url"], o["previewUrl"], o["thumbUrl"]))})
		}
		for k, p := range map[string]string{"likes": "count_like", "comments": "count_comment", "reposts": "count_share", "bookmarks": "count_bookmark"} {
			r.metric(m, k, "postSummary."+p)
		}
		if v, exists := m["isAllowToSee"]; exists {
			r.Flags["restricted"] = v != true
		}
	case "Fantia":
		r.identity(m, author, work, []string{"post_id", "content_id"}, []string{"fanclub_user_id"})
		title("post_title", "content_title")
		date("posted_at", "date")
		name("fanclub_user_name", "fanclub_name")
		handle("fanclub_name")
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
			r.Flags["adult"] = regexp.MustCompile(`(?i)adult|r-?18`).MatchString(s)
		}
		if m["filename"] != nil || HTTP(m["file_url"]) != nil {
			r.Declarations = append(r.Declarations, Declaration{SourceID: ID(m["file_id"]), Kind: Str(m["extension"]), Name: Str(m["filename"]), URL: HTTP(m["file_url"])})
		}
	case "Patreon":
		r.identity(m, author, work, []string{"id"}, []string{"creator.id"})
		title("title")
		date("published_at", "date")
		name("creator.full_name", "creator.first_name", "campaign.name")
		handle("creator.vanity")
		bio("creator.about")
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
		for _, v := range Arr(m["images"], false) {
			o := Obj(v)
			r.Declarations = append(r.Declarations, Declaration{SourceID: ID(o["id"]), Kind: "image", Name: Str(o["file_name"]), URL: HTTP(Or(Get(o, "image_urls.original"), Get(o, "image_urls.default"), Get(o, "image_urls.url")))})
		}
		for _, f := range []string{"attachments", "attachments_media"} {
			for _, v := range Arr(m[f], false) {
				o := Obj(v)
				kind := "attachment"
				if f == "attachments_media" {
					kind = "attachment_media"
				}
				r.Declarations = append(r.Declarations, Declaration{SourceID: ID(o["id"]), Kind: kind, Name: Str(Or(o["name"], o["file_name"])), URL: HTTP(Or(o["url"], o["download_url"])), Size: Integer(o["size"], true)})
			}
		}
	case "Pawchive":
		pawchive(&r, m, author, work)
		title("title")
		date("published", "date", "added")
		updated("edited")
		name("user_profile.name", "username", "user_name", "creator", "artist")
		handle("user_profile.public_id", "username")
		r.Flags["hasFull"] = Bool(m["has_full"])
		r.body(m, []string{"content", "description", "text"}, []string{"html", "html", "plain"})
		r.tags(Arr(m["tags"], false))
	case "X", "微博":
		if platform == "X" {
			r.identity(m, author, work, []string{"tweet_id", "id"}, []string{"user.id", "author.id"})
			date("date")
			name("user.name", "author.name")
			handle("user.nick", "author.nick")
			bio("user.description", "author.description")
			r.body(m, []string{"content"}, []string{"plain"})
			r.tags(Arr(m["hashtags"], false))
			r.Flags["sensitive"] = Bool(m["sensitive"])
			for k, p := range map[string]string{"likes": "favorite_count", "replies": "reply_count", "reposts": "retweet_count", "views": "view_count", "bookmarks": "bookmark_count"} {
				r.metric(m, k, p)
			}
			for k, p := range map[string]string{"reply": "reply_id", "retweet": "retweet_id", "quote": "quote_id", "conversation": "conversation_id"} {
				if x := ID(m[p]); x != nil && x != "0" {
					r.Relations = append(r.Relations, Relation{k, String(x)})
					r.Evidence = append(r.Evidence, Evidence{"relations." + k, "metadata", "$." + p, 1})
				}
			}
		} else {
			r.identity(m, author, work, []string{"idstr", "mid", "id"}, []string{"user.idstr", "user.id"})
			date("date", "created_at")
			name("user.screen_name")
			handle("user.domain", "user.weihao")
			bio("user.description")
			r.body(m, []string{"longText.content", "text_raw", "text"}, []string{"html", "plain", "html"})
			if r.Primary != nil && (m["isMarkdown"] == true || Get(m, "longText.isMarkdown") == true && r.Primary.SourcePath == "longText.content") {
				r.Primary.SourceFormat = "markdown"
			}
			a := []any{}
			for _, v := range Arr(m["topic_struct"], true) {
				a = append(a, Obj(v)["topic_title"])
			}
			if r.Primary != nil {
				for _, match := range regexp.MustCompile(`#([^#\r\n]+)#`).FindAllStringSubmatch(r.Primary.SourceText, -1) {
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
			weiboMedia(&r, m)
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
		socialProfile(&r, m, platform)
	case "Venera":
		if len(m) > 0 {
			r.Warnings++
		}
	default:
		r.Valid = false
		r.Reason = "unknown_platform"
	}
	sort.Slice(r.Evidence, func(i, j int) bool {
		a, b := r.Evidence[i], r.Evidence[j]
		if a.Field != b.Field {
			return a.Field < b.Field
		}
		if a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.Path < b.Path
	})
	return r, m
}
func socialProfile(r *Result, m Object, platform string) {
	u := Obj(m["user"])
	a := Obj(m["author"])
	pick := func(k string) any {
		if v, ok := u[k]; ok && v != nil {
			return v
		}
		return a[k]
	}
	if platform == "X" {
		r.Profile["location"] = Str(Or(u["location"], a["location"]))
		r.Profile["avatarUrl"] = HTTP(Or(u["profile_image"], a["profile_image"]))
		r.Profile["bannerUrl"] = HTTP(Or(u["profile_banner"], a["profile_banner"]))
		r.Profile["profileUrl"] = HTTP(Or(u["url"], a["url"]))
		r.Profile["followingCount"] = Integer(pick("friends_count"), true)
	} else {
		r.Profile["avatarUrl"] = HTTP(Or(u["avatar_hd"], u["avatar_large"], u["profile_image_url"]))
		r.Profile["profileUrl"] = Str(u["profile_url"])
		r.Profile["location"] = Str(u["location"])
		r.Profile["verificationType"] = Integer(u["verified_type"], true)
		r.Profile["verificationReason"] = Str(u["verified_reason"])
		r.Profile["followingCount"] = Integer(Or(u["follow_count"], u["friends_count"]), true)
	}
	r.Profile["language"] = Str(pick("lang"))
	r.Profile["verified"] = Bool(pick("verified"))
	r.Profile["followersCount"] = Integer(pick("followers_count"), true)
	r.Profile["statusesCount"] = Integer(pick("statuses_count"), true)
}
func pawchive(r *Result, m Object, author, work string) {
	parts := strings.SplitN(author, "_", 2)
	service := String(m["service"])
	user := ID(Or(m["user"], Get(m, "user_profile.id")))
	if len(parts) == 2 {
		if service != "" && service != parts[0] {
			r.Valid = false
			r.Reason = "service_identity_conflict"
		} else {
			service = parts[0]
			if user == nil {
				user = parts[1]
			}
		}
	}
	id := ID(m["id"])
	if id == nil {
		id = DirectoryWorkID(work)
		if id == nil {
			id = work
		}
	}
	if r.Valid && service != "" {
		r.Work["sourceWorkId"] = service + ":" + String(id)
		if user != nil {
			r.Profile["sourceAuthorId"] = service + ":" + String(user)
		}
	}
	fields := []string{}
	if _, ok := m["file"].(map[string]any); ok {
		fields = append(fields, "file")
	}
	fields = append(fields, "attachments", "archives")
	for _, f := range fields {
		items := Arr(m[f], false)
		if f == "file" {
			items = []any{m[f]}
		}
		for i, v := range items {
			o := Obj(v)
			p := fmt.Sprintf("%s[%d].name", f, i)
			if f == "file" {
				p = "file.name"
			}
			source := Or(o["filename"], o["id"], o["name"])
			if f == "file" {
				source = Or(o["filename"], o["name"])
			}
			decl := Declaration{SourceID: ID(source), Kind: Str(Or(o["type"], o["extension"])), Name: Str(Or(o["name"], o["filename"])), URL: HTTP(o["url"]), Hash: Str(o["hash"]), Size: Integer(o["size"], true)}
			if f != "archives" {
				if s, ok := o["name"].(string); ok && s != "" && !strings.ContainsAny(s, "\\/\x00") && s != "." && s != ".." {
					decl.References = []Reference{{"file_name", s, "$." + p}}
				}
			}
			r.Declarations = append(r.Declarations, decl)
		}
	}
}
func weiboMedia(r *Result, m Object) {
	infos := Obj(m["pic_infos"])
	for _, k := range Keys(infos) {
		o := Obj(infos[k])
		big := Obj(Or(o["largest"], o["large"], o["original"]))
		r.Declarations = append(r.Declarations, Declaration{SourceID: k, Kind: "image", URL: HTTP(big["url"])})
	}
	for _, v := range Arr(Get(m, "mix_media_info.items"), true) {
		o := Obj(v)
		data := Obj(o["data"])
		r.Declarations = append(r.Declarations, Declaration{SourceID: ID(Or(data["pic_id"], data["object_id"])), Kind: Str(Or(o["type"], data["type"]))})
	}
}
func Shape(platform string, m Object, wildcard, excluded []string, policy int) string {
	entries := map[string]bool{}
	wild := map[string]bool{}
	skip := map[string]bool{}
	for _, s := range wildcard {
		wild[s] = true
	}
	for _, s := range excluded {
		skip[s] = true
	}
	var visit func(any, string, string)
	visit = func(v any, path, pp string) {
		kind := "null"
		switch v.(type) {
		case Object:
			kind = "object"
		case []any:
			kind = "array"
		case string:
			kind = "string"
		case bool:
			kind = "boolean"
		case json.Number, float64, int64:
			kind = "number"
		}
		entries[path+":"+kind] = true
		if a, ok := v.([]any); ok {
			for _, x := range a {
				visit(x, path+"[]", pp+"[]")
			}
		}
		if o, ok := v.(Object); ok {
			for _, k := range Keys(o) {
				next := pp + "." + k
				canon := path + "[" + JSON(k) + "]"
				if wild[pp] {
					next = pp + ".*"
					canon = path + "[*]"
				}
				if !skip[next] {
					visit(o[k], canon, next)
				}
			}
		}
	}
	visit(m, "$", "$")
	parts := []string{}
	for s := range entries {
		parts = append(parts, s)
	}
	sort.Strings(parts)
	header := fmt.Sprintf("metadata-shape-signature:1\nplatform:%s\npolicy:%d\n", JSON(platform), policy)
	sum := sha256.Sum256([]byte(header + strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:])
}
func JSON(v any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	return strings.TrimSuffix(b.String(), "\n")
}
