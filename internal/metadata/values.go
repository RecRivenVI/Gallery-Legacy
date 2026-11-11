package metadata

import (
	"encoding/json"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

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
		if integerPattern.MatchString(string(n)) {
			return string(n)
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
		if !integerPattern.MatchString(n) {
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
	if !ok || s == "" || !httpPattern.MatchString(s) {
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
	return timestamp(v, time.UTC)
}

func timestamp(v any, defaultZone *time.Location) any {
	if _, ok := v.(json.Number); ok {
		return Integer(v, false)
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	s = strings.TrimSpace(s)
	if !timezonePattern.MatchString(s) {
		if t, e := time.ParseInLocation("2006-01-02T15:04:05", strings.Replace(s, " ", "T", 1), defaultZone); e == nil {
			return t.UnixMilli()
		}
		if t, e := time.ParseInLocation(time.DateOnly, s, defaultZone); e == nil {
			return t.UnixMilli()
		}
		s += "Z"
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05-0700", time.RFC1123Z, "Mon Jan 02 15:04:05 -0700 2006"} {
		if t, e := time.Parse(layout, s); e == nil {
			return t.UnixMilli()
		}
	}
	// V8's existing Date.parse accepts a trailing isolated month in text.
	// Keep the current adapter result for public legacy structural fixtures.
	if match := isolatedMonthPattern.FindStringSubmatch(s); match != nil {
		n, _ := strconv.Atoi(match[1])
		if n >= 1 && n <= 12 {
			return time.Date(2001, time.Month(n), 1, 0, 0, 0, 0, time.UTC).UnixMilli()
		}
	}
	return nil
}
func New() Result {
	return Result{Valid: true, Work: Object{}, Profile: Object{"profileLinks": []any{}}, Flags: Object{}, Access: Object{}, Metrics: Object{}, Tags: []string{}, Supplementary: []Text{}, Structured: []Object{}, Relations: []Relation{}, Evidence: []Evidence{}}
}
func (r *Result) field(m Object, group Object, key, field string, decode func(any) any, paths ...string) {
	var rejected []string
	for i, p := range paths {
		raw := Get(m, p)
		v := decode(raw)
		if raw != nil && raw != "" && v == nil {
			rejected = append(rejected, p)
		}
		if v != nil && v != "" {
			group[key] = v
			r.Evidence = append(r.Evidence, Evidence{field, "metadata", "$." + p, i + 1})
			return
		}
	}
	for _, p := range rejected {
		r.reject(p, "unsupported_value")
	}
}

func (r *Result) reject(path, reason string) {
	r.InvalidFields++
	r.Issues = append(r.Issues, FieldIssue{Path: "$." + path, Reason: reason})
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

var timestampName = timestampPattern

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
	if numericIDPattern.MatchString(s) || uuidPattern.MatchString(s) {
		return s
	}
	return nil
}
func AuthorIDFor(platform, s string) any {
	if platform == "Venera" {
		return nil
	}
	if platform == "Gank" {
		if uuidPattern.MatchString(s) {
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
	if numericIDPattern.MatchString(s) {
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
		if secretQueryPattern.MatchString(k) {
			return nil
		}
	}
	return s
}
