// Package mediaorder defines presentation roles and deterministic page/cover order.
package mediaorder

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
)

var digits = regexp.MustCompile(`[0-9]+`)
var cover = regexp.MustCompile(`(?i)^\.?cover\.[^.]+$`)
var preview = regexp.MustCompile(`^[1-9]\.[^.]+$`)

func naturalKey(value string) string {
	return digits.ReplaceAllStringFunc(protocol.Lower(value), func(digits string) string {
		number := strings.TrimLeft(digits, "0")
		if number == "" {
			number = "0"
		}
		length := strconv.Itoa(len(number))
		return "\x01" + strings.Repeat("0", 10-len(length)) + length + ":" + number + "\x01"
	})
}
func Compare(a, b string) int {
	if c := slices.Compare(utf16.Encode([]rune(naturalKey(a))), utf16.Encode([]rune(naturalKey(b)))); c != 0 {
		return c
	}
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}
func Role(name string, previews bool) (string, bool) {
	isCover, isPreview := cover.MatchString(name), previews && preview.MatchString(name)
	role := "content"
	if isCover {
		role = "cover"
	} else if isPreview {
		role = "preview"
	}
	return role, !isCover && !isPreview && !strings.HasPrefix(name, ".")
}
func CoverRank(name string, previews bool) int {
	if previews && strings.HasPrefix(name, "1.") && preview.MatchString(name) {
		return 0
	}
	if cover.MatchString(name) {
		return 1
	}
	return 2
}

type Cover struct {
	ID                   int64
	Kind, Name, Relative string
}

func Better(a, b Cover, previews bool) bool {
	if b.ID == 0 {
		return true
	}
	if a.Kind != b.Kind {
		return a.Kind == "image"
	}
	if ar, br := CoverRank(a.Name, previews), CoverRank(b.Name, previews); ar != br {
		return ar < br
	}
	return Compare(a.Relative, b.Relative) < 0
}
