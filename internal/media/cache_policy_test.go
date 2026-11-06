package media

import (
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func TestPreviewKeySurvivesMovingInstanceAndSeparatesTiers(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "source.jpg")
	if err := os.WriteFile(file, []byte("synthetic"), 0600); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(file)
	f := File{Root: root, Path: file, Info: info, Platform: "pixiv", WorkID: "1", MediaID: "1"}
	a, err := PreviewKey(f, "s")
	if err != nil {
		t.Fatal(err)
	}
	f.Root = filepath.Join(root, "relocated")
	f.Path = filepath.Join(f.Root, "source.jpg")
	f.WorkID = "99"
	f.MediaID = "99"
	b, err := PreviewKey(f, "s")
	if err != nil {
		t.Fatal(err)
	}
	c, _ := PreviewKey(f, "m")
	if a != b || b == c {
		t.Fatal("key depends on absolute paths/row IDs, or misses tier")
	}
}

func TestQueuedVisiblePreviewPrecedesBackgroundAndCancellationRemovesWaiter(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "source.jpg")
	os.WriteFile(file, []byte("synthetic"), 0600)
	info, _ := os.Stat(file)
	c, err := NewCache(instance.Config{InstanceRoot: root, CacheRoot: filepath.Join(root, "cache"), TempRoot: filepath.Join(root, "temp")}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	entered := make(chan string, 8)
	release := make(chan struct{}, 8)
	c.mu.Lock()
	c.render = func(ctx context.Context, f File, _, _ string) (imaging.Preview, error) {
		entered <- filepath.Base(f.Path)
		select {
		case <-ctx.Done():
			return imaging.Preview{}, ctx.Err()
		case <-release:
			return imaging.Preview{Original: true, Width: 1, Height: 1, Hash: []byte{1}}, nil
		}
	}
	c.mu.Unlock()
	request := func(ctx context.Context, name string, priority Priority) <-chan error {
		done := make(chan error, 1)
		go func() {
			_, _, err := c.Request(ctx, File{Root: root, Path: filepath.Join(root, name), Info: info, Platform: "pixiv"}, "s", priority)
			done <- err
		}()
		return done
	}
	a := request(context.Background(), "active-a.jpg", Visible)
	b := request(context.Background(), "active-b.jpg", Visible)
	for range 2 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("active jobs did not start")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancelled := request(ctx, "cancelled.jpg", Nearby)
	background := request(context.Background(), "background.jpg", Background)
	visible := request(context.Background(), "visible.jpg", Visible)
	deadline := time.Now().Add(time.Second)
	for {
		c.mu.Lock()
		n := len(c.queue)
		c.mu.Unlock()
		if n == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("queued requests missing")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err = <-cancelled; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	release <- struct{}{}
	select {
	case name := <-entered:
		if name != "visible.jpg" {
			t.Fatal("background beat visible", name)
		}
	case <-time.After(time.Second):
		t.Fatal("visible job did not start")
	}
	release <- struct{}{}
	release <- struct{}{}
	select {
	case name := <-entered:
		if name != "background.jpg" {
			t.Fatal("background job missing", name)
		}
	case <-time.After(time.Second):
		t.Fatal("background did not resume")
	}
	release <- struct{}{}
	for _, done := range []<-chan error{a, b, visible, background} {
		if err = <-done; err != nil {
			t.Fatal(err)
		}
	}
	c.mu.Lock()
	queued := len(c.queue)
	c.mu.Unlock()
	if queued != 0 {
		t.Fatal("cancelled job stayed queued")
	}
}

func TestCacheNativeTiersAndDatabasePlaceholder(t *testing.T) {
	dir := os.Getenv("GALLERY_VIPS_DIR")
	if dir == "" {
		t.Skip("set GALLERY_VIPS_DIR to pinned DLL directory")
	}
	e, err := imaging.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	file := filepath.Join(root, "source.jpg")
	out, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 1600, 1200))
	for y := 0; y < 1200; y++ {
		for x := 0; x < 1600; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 255), uint8(y % 255), 100, 255})
		}
	}
	if err = jpeg.Encode(out, img, nil); err != nil {
		t.Fatal(err)
	}
	out.Close()
	info, _ := os.Stat(file)
	c, err := NewCache(instance.Config{InstanceRoot: root, CacheRoot: filepath.Join(root, "cache"), TempRoot: filepath.Join(root, "temp"), ThumbnailCacheBytes: 20 << 30}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.mu.Lock()
	c.render = func(ctx context.Context, f File, target, tier string) (imaging.Preview, error) {
		return c.generate(ctx, func() (*imaging.Engine, error) { return e, nil }, f, target, tier)
	}
	c.mu.Unlock()
	f := File{Path: file, Root: root, Info: info, Platform: "pixiv", Kind: "image"}
	for _, tier := range []string{"s", "m", "l"} {
		result, state, err := c.Request(context.Background(), f, tier, Visible)
		if err != nil {
			t.Fatal(tier, err)
		}
		if tier == "l" {
			if state != "original" || result.Path != file {
				t.Fatal("upscaled a small original")
			}
		} else if MIME(result.Path) != "image/webp" {
			t.Fatal("not WebP", result.Path)
		}
		result.Release()
	}
	key, _ := PreviewKey(f, "s")
	summary, err := c.LookupSummary(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	if summary["width"] != 1600 || summary["height"] != 1200 || summary["thumbHash"] == "" {
		t.Fatal(summary)
	}
	if matches, _ := filepath.Glob(filepath.Join(c.root, "*", "*", "*.json")); len(matches) != 0 {
		t.Fatal("JSON sidecars remain")
	}
}

func TestEvictionRetainsResponsesUntilStreamingEnds(t *testing.T) {
	root := t.TempDir()
	c, err := NewCache(instance.Config{InstanceRoot: root, CacheRoot: filepath.Join(root, "cache"), TempRoot: filepath.Join(root, "temp"), ThumbnailCacheBytes: 1}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.mu.Lock()
	c.render = func(_ context.Context, _ File, target, tier string) (imaging.Preview, error) {
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return imaging.Preview{}, err
		}
		err := os.WriteFile(target, []byte("synthetic-preview"), 0600)
		return imaging.Preview{Width: 1000, Height: 800, Hash: []byte("synthetic-hash")}, err
	}
	c.mu.Unlock()
	request := func(name string) File {
		t.Helper()
		source := filepath.Join(root, name)
		if err := os.WriteFile(source, []byte("synthetic-source"), 0600); err != nil {
			t.Fatal(err)
		}
		info, _ := os.Stat(source)
		file, _, err := c.Request(context.Background(), File{Path: source, Root: root, RelativeKey: name, Platform: "pixiv", Info: info}, "m", Visible)
		if err != nil {
			t.Fatal(err)
		}
		return file
	}
	first := request("one.jpg")
	defer first.Release()
	second := request("two.jpg")
	defer second.Release()
	if err = c.evict(""); err != nil {
		t.Fatal(err)
	}
	for _, file := range []File{first, second} {
		if _, err = os.Stat(file.Path); err != nil {
			t.Fatal("active response evicted", err)
		}
	}
	first.Release()
	if _, err = os.Stat(second.Path); err != nil {
		t.Fatal("other active response evicted", err)
	}
	second.Release()
	var bytes int64
	if err = c.index.db.QueryRow("SELECT coalesce(sum(bytes),0) FROM thumbnails WHERE tier!='s'").Scan(&bytes); err != nil || bytes > 1 {
		t.Fatal("released responses exceed cache limit", bytes, err)
	}
}
