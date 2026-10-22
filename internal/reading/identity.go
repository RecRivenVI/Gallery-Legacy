package reading

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
)

func lower(value string) string { return protocol.Lower(value) }
func component(value string) string {
	return protocol.Component(value)
}

func (v *View) MediaIdentity(id int64) (string, error) {
	m, err := v.Media(id)
	return mediaIdentity(m), err
}

func NaturalCompare(a, b string) int {
	if c := slices.Compare(utf16.Encode([]rune(naturalKey(a))), utf16.Encode([]rune(naturalKey(b)))); c != 0 {
		return c
	}
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}
func publicPath(platform, relative string) string {
	return "/p/" + component(platform) + "/" + strings.ReplaceAll(relative, "\\", "/")
}
func parsePath(value string) (string, string, bool) {
	if len([]rune(value)) > 8192 || !strings.HasPrefix(value, "/p/") {
		return "", "", false
	}
	platform, relative, ok := strings.Cut(value[3:], "/")
	if !ok || relative == "" {
		return "", "", false
	}
	platform, err := url.PathUnescape(platform)
	if err != nil {
		return "", "", false
	}
	if _, ok := metadata.Versions[platform]; !ok {
		return "", "", false
	}
	relative = strings.ReplaceAll(relative, "/", "\\")
	if strings.ContainsRune(relative, 0) || strings.HasPrefix(relative, "\\") || regexp.MustCompile(`^[A-Za-z]:`).MatchString(relative) {
		return "", "", false
	}
	parts := strings.FieldsFunc(relative, func(r rune) bool { return r == '\\' })
	for _, part := range parts {
		if part == "." || part == ".." {
			return "", "", false
		}
	}
	return platform, lower(strings.Join(parts, "\\")), len(parts) > 0
}
func mediaIdentity(m Row) string {
	if m == nil {
		return ""
	}
	// Array has no HTML escaping in JSON.stringify.
	value := []string{text(m["platform_id"]), lower(text(m["work_relative_path"])), text(m["relative_path_key"])}
	bytes, _ := json.Marshal(value)
	text := string(bytes)
	for _, pair := range [][2]string{{`\u003c`, "<"}, {`\u003e`, ">"}, {`\u0026`, "&"}, {`\u2028`, "\u2028"}, {`\u2029`, "\u2029"}} {
		text = strings.ReplaceAll(text, pair[0], pair[1])
	}
	hash := sha256.Sum256([]byte(text))
	return hex.EncodeToString(hash[:])[:32]
}

var digitRun = regexp.MustCompile(`[0-9]+`)
var coverFile = regexp.MustCompile(`(?i)^\.?cover\.[^.]+$`)
var previewFile = regexp.MustCompile(`^[1-9]\.[^.]+$`)

func naturalKey(value string) string {
	return digitRun.ReplaceAllStringFunc(lower(value), func(digits string) string {
		number := strings.TrimLeft(digits, "0")
		if number == "" {
			number = "0"
		}
		length := strconv.Itoa(len(number))
		return "\x01" + strings.Repeat("0", 10-len(length)) + length + ":" + number + "\x01"
	})
}
func sortMedia(rows []Row) {
	slices.SortFunc(rows, func(a, b Row) int {
		x, y := text(a["relative_path"]), text(b["relative_path"])
		return NaturalCompare(x, y)
	})
}
func presentation(name string, previews bool) (string, bool) {
	cover, preview := coverFile.MatchString(name), previews && previewFile.MatchString(name)
	role := "content"
	if cover {
		role = "cover"
	} else if preview {
		role = "preview"
	}
	return role, !cover && !preview && !strings.HasPrefix(name, ".")
}
func coverRank(name string, previews bool) int {
	if previews && strings.HasPrefix(name, "1.") && previewFile.MatchString(name) {
		return 0
	}
	if coverFile.MatchString(name) {
		return 1
	}
	return 2
}
func sortCover(rows []Row, mediaType string, previews bool) {
	preferred := "image"
	if mediaType == "video" {
		preferred = "video"
	}
	slices.SortStableFunc(rows, func(a, b Row) int {
		ai, bi := 1, 1
		if a["filesystem_media_type"] == preferred {
			ai = 0
		}
		if b["filesystem_media_type"] == preferred {
			bi = 0
		}
		if ai != bi {
			return ai - bi
		}
		if c := coverRank(text(a["filesystem_file_name"]), previews) - coverRank(text(b["filesystem_file_name"]), previews); c != 0 {
			return c
		}
		x, y := text(a["relative_path"]), text(b["relative_path"])
		return NaturalCompare(x, y)
	})
}
