package reading

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/mediaorder"
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

var NaturalCompare = mediaorder.Compare

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

// DecodePath uses the same identity normalization as public resolution.
func DecodePath(value string) (string, string, bool) { return parsePath(value) }

func (v *View) WorkIdentity(value string) (Row, error) {
	platform, key, ok := parsePath(value)
	if !ok {
		return nil, nil
	}
	return v.row("SELECT work_id,media_count FROM works w WHERE platform_id=? AND relative_path_key=?", platform, key)
}

func (v *View) ReadableCount(workID int64) (int64, error) {
	row, err := v.row("SELECT "+visibleCountSQL("w")+" n FROM works w WHERE w.work_id=?", workID)
	if err != nil || row == nil {
		return 0, err
	}
	return row["n"].(int64), nil
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

func sortMedia(rows []Row) {
	slices.SortFunc(rows, func(a, b Row) int {
		x, y := text(a["relative_path"]), text(b["relative_path"])
		return NaturalCompare(x, y)
	})
}

var presentation = mediaorder.Role
var coverRank = mediaorder.CoverRank

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
