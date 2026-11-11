package metadata

import (
	"testing"
	"time"
)

func TestXExactIDsAndFieldDiagnostics(t *testing.T) {
	r, _ := Parse("X", "700", "work", []byte(`{"tweet_id":false,"id":900719925474099312345,"conversation_id":900719925474099312346,"user":{"id":900719925474099312347},"quoted_id":{},"favorite_count":9007199254740993}`))
	if r.Work["sourceWorkId"] != "900719925474099312345" || r.Profile["sourceAuthorId"] != "900719925474099312347" || len(r.Relations) != 1 || r.Relations[0].SourceID != "900719925474099312346" || r.Metrics["likes"] != nil {
		t.Fatalf("identity or metric changed incorrectly: %+v", r)
	}
	if r.InvalidFields != 1 || len(r.Issues) != 1 || r.Issues[0] != (FieldIssue{"$.quoted_id", "invalid_id"}) {
		t.Fatalf("diagnostics: %+v", r.Issues)
	}
}

func TestPublicationFallbackAndTimeZones(t *testing.T) {
	utc := time.Date(2026, 1, 2, 15, 4, 5, 0, time.UTC)
	for _, c := range []struct {
		platform, author, raw string
		published, edited     any
	}{
		{"Fantia", "7", `{"date":"2026-01-02 15:04:05","posted_at":"bad"}`, utc.UnixMilli(), nil},
		{"Fantia", "7", `{"date":false,"posted_at":"Sat, 03 Jan 2026 00:04:05 +0900"}`, utc.UnixMilli(), nil},
		{"Pawchive", "fanbox_7", `{"date":"2026-01-03 00:04:05","published":"2026-01-03 00:04:05","edited":"2026-01-02T15:04:05Z","added":"2026-01-02 01:00:00"}`, utc.UnixMilli(), utc.UnixMilli()},
		{"Pawchive", "fanbox_7", `{"published":"2026-01-03 00:04:05","edited":"2026-01-03 00:04:05"}`, utc.UnixMilli(), utc.UnixMilli()},
		{"Pawchive", "fanbox_7", `{"added":"2026-01-02 15:04:05"}`, nil, nil},
		{"Pawchive", "patreon_7", `{"published":"2026-01-02 15:04:05"}`, utc.UnixMilli(), nil},
	} {
		r, _ := Parse(c.platform, c.author, "work", []byte(c.raw))
		if r.Work["publishedAtMs"] != c.published || r.Work["updatedAtMs"] != c.edited || r.InvalidFields != 0 {
			t.Fatalf("%s %s: work=%+v issues=%+v", c.platform, c.author, r.Work, r.Issues)
		}
	}
}
