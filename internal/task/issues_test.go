package task

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func TestIssuePagesKeepFailuresBeyondStatusPreview(t *testing.T) {
	c := instance.Config{StateRoot: t.TempDir()}
	f, err := os.Create(filepath.Join(c.StateRoot, "scan-issues.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	enc := json.NewEncoder(f)
	for i := range 251 {
		if err = enc.Encode(Row{"code": "METADATA_MALFORMED", "ordinal": i}); err != nil {
			t.Fatal(err)
		}
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := Issues(c, 6)
	if err != nil {
		t.Fatal(err)
	}
	rows := r["items"].([]Row)
	if r["total"] != 251 || len(rows) != 1 || rows[0]["ordinal"] != float64(250) {
		t.Fatal("issue history truncated by status preview", r)
	}
}
