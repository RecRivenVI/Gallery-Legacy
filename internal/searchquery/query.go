// Package searchquery parses the public search language. Offsets are UTF-8 byte
// offsets so clients remove the exact original token instead of reformatting it.
package searchquery

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"golang.org/x/text/unicode/norm"
)

var prefixes = map[string]string{"标题": "title", "title": "title", "作者": "author", "author": "author", "账号": "user", "user": "user", "作者id": "uid", "uid": "uid", "id": "id", "标签": "tag", "tag": "tag", "正文": "text", "text": "text", "我的标签": "mytag", "mytag": "mytag", "平台": "platform", "platform": "platform"}
var platforms = map[string]string{"p": "pixiv", "pixiv": "pixiv", "f": "pixivFANBOX", "fanbox": "pixivFANBOX", "pixivfanbox": "pixivFANBOX", "g": "Gank", "gank": "Gank", "fantia": "Fantia", "patreon": "Patreon", "pw": "Pawchive", "pawchive": "Pawchive", "x": "X", "twitter": "X", "微": "微博", "微博": "微博", "v": "Venera", "venera": "Venera"}

func Platform(value string) string {
	value = norm.NFKC.String(strings.TrimSpace(value))
	// Single-letter F and P are deliberately case-sensitive platform badges.
	if value == "F" {
		return "Fantia"
	}
	if value == "P" {
		return "Patreon"
	}
	return platforms[strings.ToLower(strings.TrimSpace(value))]
}

func Parse(input string) []api.SearchTerm {
	result := []api.SearchTerm{}
	for start := 0; start < len(input); {
		r, n := utf8.DecodeRuneInString(input[start:])
		if unicode.IsSpace(r) {
			start += n
			continue
		}
		end := start
		quoted := false
		for end < len(input) {
			r, n = utf8.DecodeRuneInString(input[end:])
			if r == '"' {
				quoted = !quoted
			}
			if unicode.IsSpace(r) && !quoted {
				break
			}
			end += n
		}
		raw := input[start:end]
		if quoted { // Unbalanced quotation is literal, including its spaces.
			result = append(result, api.SearchTerm{Field: "any", Value: raw, Raw: raw, Start: int64(start), End: int64(end)})
			start = end
			continue
		}
		value := raw
		exclude := strings.HasPrefix(value, "-") && len(value) > 1
		if exclude {
			value = value[1:]
		}
		field := "any"
		if colon := strings.IndexAny(value, ":："); colon >= 0 {
			name := strings.ToLower(norm.NFKC.String(value[:colon]))
			if known, ok := prefixes[name]; ok {
				field = known
				_, width := utf8.DecodeRuneInString(value[colon:])
				value = value[colon+width:]
			}
		}
		if strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) && len(value) >= 2 {
			value = value[1 : len(value)-1]
		}
		if value != "" {
			result = append(result, api.SearchTerm{Field: field, Value: value, Exclude: exclude, Raw: raw, Start: int64(start), End: int64(end)})
		}
		start = end
	}
	return result
}

func Selected(terms []api.SearchTerm) []string {
	selected := []string{}
	for _, t := range terms {
		if t.Field != "platform" || t.Exclude {
			continue
		}
		for _, value := range strings.Split(t.Value, ",") {
			if p := Platform(value); p != "" && !contains(selected, p) {
				selected = append(selected, p)
			}
		}
	}
	return selected
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
