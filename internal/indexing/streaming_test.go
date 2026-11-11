package indexing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"github.com/RecRivenVI/Gallery-Legacy/internal/physical"
)

func syntheticPipeline(t *testing.T, works int) (library.Config, inventoryProvider) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "Instance")
	config := library.Config{InstanceRoot: root, Database: filepath.Join(root, "live/catalog.sqlite"), Sources: map[string]string{}, TestOnly: true, Workers: 2, BatchSize: 4, MetadataLimit: 1 << 20, ListingSource: "auto", AllowNative: true}
	for id := range metadata.Versions {
		config.Sources[id] = filepath.Join(base, "Sources", id)
		if err := os.MkdirAll(config.Sources[id], 0700); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < works; i++ {
		work := filepath.Join(config.Sources["pixiv"], "Synthetic", fmt.Sprint(1000+i))
		if err := os.MkdirAll(work, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(work, "1.png"), []byte("synthetic"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(work, "metadata.json"), []byte(fmt.Sprintf(`{"id":%d,"title":"Synthetic %d","user":{"id":1,"name":"Synthetic"}}`, 1000+i, i)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := catalog.CreateLive(context.Background(), root, config.Sources); err != nil {
		t.Fatal(err)
	}
	provider := func(ctx context.Context, l *library.Listing, c library.Config, ids []string, author string, _ bool) error {
		for _, id := range ids {
			if err := l.LoadNativeScope(ctx, id, c.Sources[id], author); err != nil {
				return err
			}
			l.MarkIndexed(id)
		}
		return nil
	}
	return config, provider
}

func TestStreamingHugeAuthorVisibleBeforeCompletionAndIncrementalReuses(t *testing.T) {
	config, provider := syntheticPipeline(t, 80)
	config.AllowNative = false
	p := &Pipeline{Config: config, Inventory: provider, Delay: 30 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.Run(ctx, []string{"pixiv"}) }()
	read, err := openRead(config.Database)
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	early := false
	for !early {
		select {
		case err := <-done:
			t.Fatal("author completed before any partial visibility", err)
		case <-time.After(20 * time.Millisecond):
		}
		var n int
		if err = read.QueryRow("SELECT count(*) FROM works").Scan(&n); err != nil {
			t.Fatal(err)
		}
		early = n > 0 && n < 80
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if p.c.Committed.Load() != 80 {
		t.Fatal("missing works", p.c.Committed.Load())
	}
	for round := 0; round < 2; round++ {
		if round == 1 {
			file := filepath.Join(config.Sources["pixiv"], "Synthetic", "1000", "metadata.json")
			if err = os.WriteFile(file, []byte(`{"id":1000,"title":"Changed synthetic title","user":{"id":1,"name":"Synthetic"}}`), 0600); err != nil {
				t.Fatal(err)
			}
		}
		inc := &Pipeline{Config: config, Inventory: provider, Mode: "incremental"}
		if err = inc.Run(ctx, []string{"pixiv"}); err != nil {
			t.Fatal(err)
		}
		want := int64(round)
		if inc.c.MetadataReads.Load() != want || inc.reused.Load() != 80-want || inc.c.Committed.Load() != want || inc.anchorReads.Load() != 0 {
			t.Fatalf("changed=%d reads=%d reused=%d committed=%d anchors=%d", round, inc.c.MetadataReads.Load(), inc.reused.Load(), inc.c.Committed.Load(), inc.anchorReads.Load())
		}
		if round == 0 && inc.c.DirectoryReads.Load() != 0 {
			t.Fatal("unchanged works traversed")
		}
	}
}

func TestFileTableUnavailableFallsBackToNativeCompleteWorks(t *testing.T) {
	config, provider := syntheticPipeline(t, 3)
	provider = func(context.Context, *library.Listing, library.Config, []string, string, bool) error {
		return errors.New("NTFS_VOLUME_REQUIRED")
	}
	p := &Pipeline{Config: config, Inventory: provider}
	if err := p.Run(context.Background(), []string{"pixiv"}); err != nil {
		t.Fatal(err)
	}
	if p.c.Committed.Load() != 3 || p.c.MetadataReads.Load() != 3 || p.c.DirectoryReads.Load() == 0 {
		t.Fatal("native fallback skipped physical works")
	}
}

func TestIncompleteInventoryCannotSilentlyRemoveMedia(t *testing.T) {
	config, provider := syntheticPipeline(t, 1)
	p := &Pipeline{Config: config, Inventory: provider}
	if err := p.Run(context.Background(), []string{"pixiv"}); err != nil {
		t.Fatal(err)
	}
	// Excluding a descendant leaves the verified native signature unmatched.
	original := provider
	provider = func(ctx context.Context, l *library.Listing, c library.Config, ids []string, author string, incremental bool) error {
		if err := original(ctx, l, c, ids, author, incremental); err != nil {
			return err
		}
		_, err := l.DB.ExecContext(ctx, "DELETE FROM entries WHERE name='1.png'")
		return err
	}
	inc := &Pipeline{Config: config, Inventory: provider, Mode: "incremental"}
	if err := inc.Run(context.Background(), []string{"pixiv"}); err != nil {
		t.Fatal(err)
	}
	read, err := openRead(config.Database)
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	var n int
	if err = read.QueryRow("SELECT count(*) FROM media").Scan(&n); err != nil || n != 1 {
		t.Fatal("excluded existing media removed", n, err)
	}
}

func TestPhysicalMetadataOrderPreservesNativeResult(t *testing.T) {
	config, _ := syntheticPipeline(t, 4)
	config.ListingSource = "filesystem"
	config.Workers = 1
	ordered := config
	ordered.InstanceRoot = filepath.Join(filepath.Dir(config.InstanceRoot), "OrderedInstance")
	ordered.Database = filepath.Join(ordered.InstanceRoot, "live/catalog.sqlite")
	if err := catalog.CreateLive(context.Background(), ordered.InstanceRoot, ordered.Sources); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "order.jsonl")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	encoder := json.NewEncoder(f)
	for i := 0; i < 4; i++ {
		rel := fmt.Sprintf("Synthetic\\%d\\metadata.json", 1000+i)
		path, err := library.Join(config.Sources["pixiv"], rel)
		if err != nil {
			t.Fatal(err)
		}
		st, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if err = encoder.Encode(physical.OrderRecord{MetadataFile: physical.MetadataFile{Platform: "pixiv", Relative: rel, Offset: int64(4-i) * 4096, Size: st.Size(), Mtime: st.ModTime().UnixNano()}}); err != nil {
			t.Fatal(err)
		}
	}
	if err = encoder.Encode(physical.OrderRecord{Complete: true, Files: 4}); err != nil {
		t.Fatal(err)
	}
	f.Close()
	plain := &Pipeline{Config: config}
	if err = plain.Run(context.Background(), []string{"pixiv"}); err != nil {
		t.Fatal(err)
	}
	p := &Pipeline{Config: ordered, Device: func(string) (string, int) { return "synthetic-hdd", 2 }, PhysicalOrder: func(context.Context, library.Config, []string) (string, func(), error) { return file, func() {}, nil }}
	if err = p.Run(context.Background(), []string{"pixiv"}); err != nil {
		t.Fatal(err)
	}
	if p.c.MetadataReads.Load() != 4 {
		t.Fatal("ordered metadata read twice", p.c.MetadataReads.Load())
	}
	read, err := openRead(ordered.Database)
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	rows, err := read.Query("SELECT relative_path FROM works ORDER BY work_id")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	rows.Close()
	if strings.Join(names, "|") != "Synthetic\\1003|Synthetic\\1002|Synthetic\\1001|Synthetic\\1000" {
		t.Fatal("physical order not applied before metadata reads", names)
	}
	first, err := openRead(config.Database)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	for _, query := range []string{"SELECT count(*),sum(media_count) FROM works", "SELECT count(*),sum(filesystem_size) FROM media"} {
		var a, b, c, d int64
		if err = first.QueryRow(query).Scan(&a, &b); err != nil {
			t.Fatal(err)
		}
		if err = read.QueryRow(query).Scan(&c, &d); err != nil {
			t.Fatal(err)
		}
		if a != c || b != d {
			t.Fatal("ordered result differs", query)
		}
	}
}

func TestNativeDeepAndSpilledWorkCommitsAllMedia(t *testing.T) {
	config, _ := syntheticPipeline(t, 1)
	config.ListingSource = "filesystem"
	root := filepath.Join(config.Sources["pixiv"], "Synthetic", "1000")
	deep := root
	for i := 0; i < 130; i++ {
		deep = filepath.Join(deep, "d")
	}
	if err := os.MkdirAll(deep, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "deep.png"), []byte("synthetic"), 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2050; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("extra-%04d.png", i)), []byte("synthetic"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	p := &Pipeline{Config: config}
	if err := p.Run(context.Background(), []string{"pixiv"}); err != nil {
		t.Fatal(err)
	}
	read, err := openRead(config.Database)
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	var count int
	if err = read.QueryRow("SELECT count(*) FROM media").Scan(&count); err != nil || count != 2052 {
		t.Fatal("large physical work incomplete", count, err)
	}
	files, err := filepath.Glob(filepath.Join(config.InstanceRoot, "temp", "large-work-*.sqlite"))
	if err != nil || len(files) != 0 {
		t.Fatal("owned work stage retained after commit", files, err)
	}
}

func TestCancelStreamingScanReleasesBudgetsAndResumesCommittedWorks(t *testing.T) {
	config, provider := syntheticPipeline(t, 80)
	p := &Pipeline{Config: config, Inventory: provider, Delay: 15 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- p.Run(ctx, []string{"pixiv"}) }()
	deadline := time.Now().Add(5 * time.Second)
	for p.c.Committed.Load() < 4 {
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatal("no early commit")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	for _, b := range []*Budget{p.rawBudget, p.queueBudget} {
		if b.used != 0 {
			t.Fatal("cancelled pipeline retained memory budget", b.used)
		}
	}
	if len(p.prepareSlots) != 0 {
		t.Fatal("preparation permits retained")
	}
	for _, disk := range p.disks {
		if len(disk) != 0 {
			t.Fatal("device permits retained")
		}
	}
	committed := p.c.Committed.Load()
	read, err := openRead(config.Database)
	if err != nil {
		t.Fatal(err)
	}
	var n int64
	if err = read.QueryRow("SELECT count(*) FROM works").Scan(&n); err != nil || n != committed {
		t.Fatal("cancel discarded committed works", n, committed, err)
	}
	read.Close()
	resume := &Pipeline{Config: config, Inventory: provider, Mode: "incremental"}
	if err = resume.Run(context.Background(), []string{"pixiv"}); err != nil {
		t.Fatal(err)
	}
	if resume.reused.Load() != committed || resume.c.Committed.Load() != 80-committed {
		t.Fatal("committed work ledger not reused after cancellation", resume.reused.Load(), committed)
	}
}
