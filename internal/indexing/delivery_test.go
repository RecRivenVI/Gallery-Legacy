package indexing

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/physical"
)

func TestAuthorReplayContinuesWithPreparationBudgetFull(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	l, err := library.NewListing(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	p := &Pipeline{
		Mode: "full", queueBudget: NewBudget(10), replayBudget: NewBudget(10),
		preparation: map[string]*preparationMetrics{"pixiv": {}},
	}
	output := make(chan message, 2)
	d, err := newDeliveryQueue(ctx, p, l, output)
	if err != nil {
		t.Fatal(err)
	}
	d.ctx = ctx
	if err = p.queueBudget.Acquire(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if err = d.accept(message{platform: "pixiv", bytes: 10, work: &catalog.PreparedWork{AuthorKey: "author"}}); err != nil {
		t.Fatal(err)
	}
	// A producer reserves the entire preparation budget before sending.
	if err = p.queueBudget.Acquire(ctx, 10); err != nil {
		t.Fatal(err)
	}
	defer p.queueBudget.Release(10)
	if err = d.accept(message{platform: "pixiv", key: "author", complete: true}); err != nil {
		t.Fatal(err)
	}
	work, end := <-output, <-output
	if !work.replayed || work.work == nil || !end.complete {
		t.Fatal("expected prepared work followed by the author completion")
	}
	if err = p.discardMessage(work); err != nil {
		t.Fatal(err)
	}
	if p.replayBudget.used != 0 || p.queueBudget.used != 10 {
		t.Fatal("the work must release only its replay reservation")
	}
}

func TestHDDFullScanPublishesFirstCompletedAuthor(t *testing.T) {
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
	p := &Pipeline{Config: config, Mode: "full", Inventory: provider, Device: func(string) (string, int) { return "synthetic-rotational", 2 }, PhysicalOrder: func(context.Context, library.Config, []string) (string, func(), error) { return file, func() {}, nil }}
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
	if first != `Synthetic\1000` || p.c.SpoolNanos.Load() == 0 || p.c.MetadataReads.Load() != 4 {
		t.Fatal("author completed first in physical order did not publish first", first, p.c.SpoolNanos.Load(), p.c.MetadataReads.Load())
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
