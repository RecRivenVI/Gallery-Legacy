package indexing

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/physical"
)

func TestHDDReadsPhysicalOrderButPublishesSmallAuthorFirst(t *testing.T) {
	config, provider := syntheticPipeline(t, 3)
	tiny := filepath.Join(config.Sources["pixiv"], "Tiny", "9000")
	if err := os.MkdirAll(tiny, 0700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"1.png": "synthetic", "metadata.json": `{"id":9000,"user":{"id":2,"name":"Tiny"}}`} {
		if err := os.WriteFile(filepath.Join(tiny, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(t.TempDir(), "physical.jsonl")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	encoder := json.NewEncoder(f)
	for i, relative := range []string{`Synthetic\1000\metadata.json`, `Synthetic\1001\metadata.json`, `Synthetic\1002\metadata.json`, `Tiny\9000\metadata.json`} {
		st, err := os.Stat(filepath.Join(config.Sources["pixiv"], relative))
		if err != nil {
			t.Fatal(err)
		}
		if err = encoder.Encode(physical.OrderRecord{MetadataFile: physical.MetadataFile{Platform: "pixiv", Relative: relative, Offset: int64(i), Size: st.Size(), Mtime: st.ModTime().UnixNano()}}); err != nil {
			t.Fatal(err)
		}
	}
	encoder.Encode(physical.OrderRecord{Complete: true, Files: 4})
	f.Close()
	p := &Pipeline{Config: config, Inventory: provider, Device: func(string) (string, int) { return "synthetic-rotational", 2 }, PhysicalOrder: func(context.Context, library.Config, []string) (string, func(), error) { return file, func() {}, nil }}
	if err = p.Run(context.Background(), []string{"pixiv"}); err != nil {
		t.Fatal(err)
	}
	read, err := openRead(config.Database)
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	var first string
	if err = read.QueryRow("SELECT relative_path FROM works ORDER BY work_id LIMIT 1").Scan(&first); err != nil {
		t.Fatal(err)
	}
	if first != `Tiny\9000` || p.c.SpoolNanos.Load() == 0 || p.c.MetadataReads.Load() != 4 {
		t.Fatal("physical reading and author publication were not separated", first, p.c.SpoolNanos.Load(), p.c.MetadataReads.Load())
	}
	entries, err := os.ReadDir(filepath.Join(config.InstanceRoot, "temp"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "pending-delivery-") {
			t.Fatal("staged delivery leaked")
		}
	}
	if p.queueBudget.used != 0 {
		t.Fatal("prepared budget leaked", p.queueBudget.used)
	}
}
