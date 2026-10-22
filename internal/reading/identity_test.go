package reading

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"
)

func TestFrozenNaturalOrder(t *testing.T) {
	file := os.Getenv("GALLERY_HTTP_GOLDEN")
	if file == "" {
		t.Skip("frozen Node ordering capture required")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Order struct{ Input, Expected []string }
	}
	if err = json.Unmarshal(b, &golden); err != nil {
		t.Fatal(err)
	}
	if len(golden.Order.Input) == 0 {
		t.Fatal("ordering oracle absent")
	}
	got := slices.Clone(golden.Order.Input)
	slices.SortFunc(got, NaturalCompare)
	if !reflect.DeepEqual(golden.Order.Expected, got) {
		t.Fatalf("Node %v Go %v", golden.Order.Expected, got)
	}
	rows := []Row{}
	for _, s := range golden.Order.Input {
		rows = append(rows, Row{"relative_path": s})
	}
	sortMedia(rows)
	for i, r := range rows {
		if r["relative_path"] != got[i] {
			t.Fatalf("Reader media ordering drift at %d", i)
		}
	}
}
