package metadata

import "testing"

func TestXRawIdentityDiagnosticsAreNotCountedAgainBySelection(t *testing.T) {
	for _, tt := range []struct {
		raw   string
		count int
	}{
		{`{"tweet_id":9007199254740992,"conversation_id":9007199254740992,"user":{"id":1},"author":{"id":2}}`, 2},
		{`{"tweet_id":9007199254740992,"conversation_id":9007199254740992,"user":{"id":9007199254740992},"author":{"id":9007199254740992}}`, 4},
	} {
		r, _ := Parse("X", "700", "2026-01-01_00-00-00_work", []byte(tt.raw))
		if r.InvalidFields != tt.count || r.Warnings != tt.count {
			t.Fatalf("invalid=%d warnings=%d; want %d (frozen Node raw-candidate diagnostics)", r.InvalidFields, r.Warnings, tt.count)
		}
	}
}
