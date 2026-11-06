package protocol

import (
	"encoding/json"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

var filterKeys = []string{"platforms", "includeTags", "excludeTags", "types", "ratings", "ai", "paid", "from", "to", "pages", "favorite", "minRating", "hideRead", "myTags", "my", "collection", "series", "linkedAuthor"}

func HasSearchCondition(q Query) bool {
	for _, term := range q.Terms {
		if term.Field != "platform" {
			return true
		}
	}
	for _, key := range filterKeys {
		if key != "platforms" && activeFilter(key, q.Filters.Get(key)) {
			return true
		}
	}
	return q.Tag != nil || q.AuthorID != nil || q.MediaType != "all"
}

func validateFilters(values url.Values) error {
	for _, key := range []string{"includeTags", "excludeTags", "myTags"} {
		if v := values.Get(key); v != "" {
			var tags []string
			if json.Unmarshal([]byte(v), &tags) != nil {
				return invalid("INVALID_PARAMETER")
			}
		}
	}

	for key, options := range map[string][]string{"ai": {"all", "0", "1"}, "paid": {"all", "0", "1"}, "pages": {"all", "single", "multi"}, "favorite": {"0", "1"}, "hideRead": {"0", "1"}, "my": {"favorites", "history", "continue"}} {
		if v := values.Get(key); v != "" && !slices.Contains(options, v) {
			return invalid("INVALID_PARAMETER")
		}
	}
	for _, key := range []string{"from", "to"} {
		if v := values.Get(key); v != "" {
			if _, err := time.Parse("2006-01-02", v); err != nil {
				return invalid("INVALID_PARAMETER")
			}
		}
	}
	if v := values.Get("minRating"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 5 {
			return invalid("INVALID_PARAMETER")
		}
	}
	for _, v := range strings.Split(values.Get("ratings"), ",") {
		if v != "" && v != "0" && v != "1" && v != "2" {
			return invalid("INVALID_PARAMETER")
		}
	}
	return nil
}

// Tag lists use JSON so a comma inside a tag remains part of that tag.
func TagList(value string) []string {
	var values []string
	_ = json.Unmarshal([]byte(value), &values)
	return values
}
func activeFilter(key, value string) bool {
	if value == "" || value == "all" {
		return false
	}
	switch key {
	case "includeTags", "excludeTags", "myTags":
		return len(TagList(value)) > 0
	case "favorite", "hideRead", "minRating":
		return value != "0"
	}
	return true
}
