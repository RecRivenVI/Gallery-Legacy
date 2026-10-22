package fileview

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
)

func TestCancelledSearchAndPaging(t *testing.T) {
	file := os.Getenv("GALLERY_HTTP_GOLDEN")
	if file == "" {
		t.Skip("synthetic HTTP input required")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct{ Cases []struct{ ConfigFile string } }
	if err = json.Unmarshal(b, &golden); err != nil {
		t.Fatal(err)
	}
	config, err := instance.Load(golden.Cases[0].ConfigFile)
	if err != nil {
		t.Fatal(err)
	}
	files := Browser{Config: config}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = files.Search(ctx, "files", "", "png", Options{Page: 1, Size: 48, Filter: "all", Order: "asc"})
	var e *protocol.Error
	if !errors.As(err, &e) || e.Code != "REQUEST_CANCELLED" || e.Status != 499 {
		t.Fatalf("search cancellation %v", err)
	}
	result, err := files.Search(context.Background(), "files", "", "png", Options{Page: 1e20, Size: 48, Filter: "all", Order: "asc"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result["items"].([]map[string]any)) != 0 || result["total"].(int) == 0 {
		t.Fatal("large valid search page lost total or overflowed")
	}
}
