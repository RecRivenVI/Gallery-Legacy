package media

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func TestThumbnailQueueCancellationAndDeduplication(t *testing.T) {
	base := os.Getenv("GALLERY_UNIT_ROOT")
	if base == "" {
		t.Skip("set GALLERY_UNIT_ROOT to owned scratch")
	}
	root, err := os.MkdirTemp(base, "Media-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Log(root)
		} else if err := instance.Recycle(root); err != nil {
			t.Error(err)
		}
	})
	config := instance.Config{InstanceRoot: root, CacheRoot: filepath.Join(root, "cache"), TempRoot: filepath.Join(root, "temp")}
	c, err := NewCache(config)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "synthetic.png")
	if err = os.WriteFile(file, []byte("synthetic source"), 0600); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	f := File{Path: file, Info: st, Kind: "image", Platform: "synthetic", WorkID: "1", MediaID: "1", RelativeKey: "synthetic.png"}
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int64
	c.mu.Lock()
	c.render = func(_ File, target string) error {
		if calls.Add(1) == 1 {
			close(entered)
		}
		<-release
		return os.WriteFile(target, []byte("synthetic rendered WebP"), 0600)
	}
	c.mu.Unlock()
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			if _, _, err := c.Thumbnail(context.Background(), f); err != nil {
				t.Error(err)
			}
		})
	}
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err = c.Thumbnail(ctx, f); err != context.Canceled {
		t.Errorf("request cancellation %v", err)
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("dedup generated %d copies", calls.Load())
	}
	if _, state, err := c.Thumbnail(context.Background(), f); err != nil || state != "hit" {
		t.Fatalf("cache hit %s %v", state, err)
	}
	if err = c.Close(); err != nil {
		t.Fatal(err)
	}

	c, err = NewCache(config)
	if err != nil {
		t.Fatal(err)
	}
	active := make(chan struct{}, 16)
	var failed atomic.Int64
	c.mu.Lock()
	c.render = func(_ File, _ string) error { active <- struct{}{}; <-c.ctx.Done(); return c.ctx.Err() }
	c.mu.Unlock()
	for i := range 12 {
		g := f
		g.MediaID = string(rune('a' + i))
		wg.Go(func() {
			if _, _, err := c.Thumbnail(context.Background(), g); err != nil {
				failed.Add(1)
			}
		})
	}
	for range 4 {
		select {
		case <-active:
		case <-time.After(3 * time.Second):
			t.Fatal("four workers did not start")
		}
	}
	if err = c.Close(); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if failed.Load() != 12 {
		t.Fatalf("close lost pending jobs: %d", failed.Load())
	}
	if len(active) != 0 {
		t.Fatal("more than four jobs ran concurrently")
	}
}
