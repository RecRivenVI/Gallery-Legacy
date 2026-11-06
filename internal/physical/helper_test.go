package physical

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

// Opt-in because this enumerates the NTFS volume containing the synthetic
// fixture. No real source roots, configurations or contents participate.
func TestNativeAllocationHelperOnlyEmitsSyntheticScope(t *testing.T) {
	exe := os.Getenv("GALLERY_ALLOCATION_HELPER")
	if exe == "" {
		t.Skip("build gallery-runtime and set GALLERY_ALLOCATION_HELPER")
	}
	base := t.TempDir()
	root := filepath.Join(base, "Instance")
	config := library.Config{InstanceRoot: root, Database: filepath.Join(root, "live/catalog.sqlite"), Sources: map[string]string{}, TestOnly: true}
	for id := range metadata.Versions {
		config.Sources[id] = filepath.Join(base, "Sources", id)
		if err := os.MkdirAll(config.Sources[id], 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, work := range []string{"1000", "1001"} {
		path := filepath.Join(config.Sources["pixiv"], "Synthetic", work)
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "metadata.json"), []byte(`{"synthetic":true}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"state", "temp"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(root, "state/scanner.json")
	raw, _ := json.Marshal(config)
	if err := os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	request := filepath.Join(root, "temp/physical-order-synthetic.json")
	raw, _ = json.Marshal(helperRequest{Config: file, Platforms: []string{"pixiv"}})
	if err := os.WriteFile(request, raw, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := runElevated(ctx, exe, request); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(request + "l")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	d := json.NewDecoder(f)
	seen := map[string]bool{}
	complete := false
	for {
		var item OrderRecord
		if err = d.Decode(&item); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if item.Complete {
			complete = item.Files == 2
			continue
		}
		if item.Platform != "pixiv" || item.Offset < 0 || item.Size != 18 {
			t.Fatal("invalid allocation facts", item.Platform, item.Offset, item.Size)
		}
		if item.Relative != "Synthetic\\1000\\metadata.json" && item.Relative != "Synthetic\\1001\\metadata.json" {
			t.Fatal("out-of-scope allocation emitted")
		}
		seen[item.Relative] = true
	}
	if !complete || len(seen) != 2 {
		t.Fatal("synthetic metadata missing", len(seen), complete)
	}
}

func TestNativeCoverHelperOnlyEmitsSelectedCover(t *testing.T) {
	exe := os.Getenv("GALLERY_ALLOCATION_HELPER")
	if exe == "" {
		t.Skip("build gallery-runtime and set GALLERY_ALLOCATION_HELPER")
	}
	base := t.TempDir()
	root := filepath.Join(base, "Instance")
	config := library.Config{InstanceRoot: root, Database: filepath.Join(root, "live/catalog.sqlite"), Sources: map[string]string{}, TestOnly: true}
	for id := range metadata.Versions {
		config.Sources[id] = filepath.Join(base, "Sources", id)
		if err := os.MkdirAll(config.Sources[id], 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"state", "temp", "cache"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	directory := filepath.Join(config.Sources["pixiv"], "Synthetic", "1000")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"cover.webp", "unselected.webp", "metadata.json"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("synthetic-allocation-only"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(root, "state/scanner.json")
	raw, _ := json.Marshal(config)
	if err := os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	index := filepath.Join(root, "cache/thumbs.db")
	db, err := sql.Open("sqlite", index)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE cover_jobs(platform TEXT,relative TEXT,state TEXT);INSERT INTO cover_jobs VALUES('pixiv','Synthetic/1000/cover.webp','pending'),('pixiv','Synthetic/1000/unselected.webp','done');`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	request := filepath.Join(root, "temp/physical-order-covers.json")
	raw, _ = json.Marshal(helperRequest{Config: file, Platforms: []string{"pixiv"}, CoverIndex: index})
	if err = os.WriteFile(request, raw, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err = runElevated(ctx, exe, request); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(request + "l")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	decoder := json.NewDecoder(f)
	count, complete := 0, false
	for {
		var item OrderRecord
		err = decoder.Decode(&item)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if item.Complete {
			complete = item.Files == 1
			continue
		}
		if item.Platform != "pixiv" || item.Relative != `Synthetic\1000\cover.webp` || item.Offset < 0 {
			t.Fatal("unexpected cover allocation", item)
		}
		count++
	}
	if count != 1 || !complete {
		t.Fatal("selected cover missing", count, complete)
	}
}
