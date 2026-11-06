package indexing

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPersistentFileInventoryIgnoresDirectoryTimesAndRetriesParseFailure(t *testing.T) {
	config, provider := syntheticPipeline(t, 2)
	config.AllowNative = false
	ctx := context.Background()
	scan := func(mode string) *Pipeline {
		p := &Pipeline{Config: config, Inventory: provider, Mode: mode}
		if err := p.Run(ctx, []string{"pixiv"}); err != nil {
			t.Fatal(err)
		}
		return p
	}
	scan("full")
	work := filepath.Join(config.Sources["pixiv"], "Synthetic", "1000")
	stamp := time.Now().Add(-time.Hour)
	if err := os.Chtimes(work, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	p := scan("incremental")
	if p.reused.Load() != 2 || p.c.MetadataReads.Load() != 0 || p.c.Committed.Load() != 0 {
		t.Fatal("directory time forced work I/O", p.snapshot("", false, ""))
	}
	file := filepath.Join(work, "1.png")
	st, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(file, st.ModTime().Add(time.Second), st.ModTime().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	p = scan("incremental")
	if p.reused.Load() != 1 || p.c.MetadataReads.Load() != 1 || p.c.Committed.Load() != 1 {
		t.Fatal("file change did not replace one work")
	}
	meta := filepath.Join(work, "metadata.json")
	if err = os.WriteFile(meta, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	scan("incremental")
	p = scan("incremental")
	if p.c.MetadataReads.Load() != 1 || p.reused.Load() != 1 {
		t.Fatal("parse failure recorded as complete")
	}
}

func TestEverythingFallbackRequiresExplicitConsent(t *testing.T) {
	config, provider := syntheticPipeline(t, 1)
	config.AllowNative = false
	provider.Ready = func(context.Context) error { return errors.New("EVERYTHING_NOT_READY") }
	p := &Pipeline{Config: config, Inventory: provider}
	if err := p.Run(context.Background(), []string{"pixiv"}); err == nil || code(err) != "EVERYTHING_CONFIRMATION_REQUIRED" {
		t.Fatal("silent fallback", err)
	}
	if p.c.Committed.Load() != 0 {
		t.Fatal("wrote before consent")
	}
	config.AllowNative = true
	p = &Pipeline{Config: config, Inventory: provider}
	if err := p.Run(context.Background(), []string{"pixiv"}); err != nil || p.c.Committed.Load() != 1 {
		t.Fatal("explicit fallback unavailable", err)
	}
}

func TestAuthorProgressCountsOnlySelectedAuthor(t *testing.T) {
	config, provider := syntheticPipeline(t, 2)
	other := filepath.Join(config.Sources["pixiv"], "Other", "9000")
	if err := os.MkdirAll(other, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other, "1.png"), []byte("synthetic"), 0600); err != nil {
		t.Fatal(err)
	}
	p := &Pipeline{Config: config, Inventory: provider, AuthorDirectoryName: "Synthetic"}
	if err := p.Run(context.Background(), []string{"pixiv"}); err != nil {
		t.Fatal(err)
	}
	s := p.platformProgress["pixiv"]
	if s.totalWorks != 2 || s.totalAuthors != 1 || s.works.Load() != 2 || s.authors.Load() != 1 {
		t.Fatal("author progress includes unselected works", s.totalWorks, s.totalAuthors, s.works.Load(), s.authors.Load())
	}
}
