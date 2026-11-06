package media

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func TestCoverPreloadYieldsToScanAndResumesWithoutRepeatingCompleted(t *testing.T) {
	for _, platform := range []string{"pixiv", "Venera"} {
		t.Run(platform, func(t *testing.T) {
			root := t.TempDir()
			source := filepath.Join(root, "source")
			os.MkdirAll(filepath.Join(root, "live"), 0700)
			db, err := sql.Open("sqlite", filepath.Join(root, "live", "catalog.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			_, err = db.Exec(`CREATE TABLE works(work_id INTEGER PRIMARY KEY,platform_id TEXT,relative_path TEXT,relative_path_key TEXT,cover_media_id INTEGER);CREATE TABLE media(media_id INTEGER PRIMARY KEY,work_id INTEGER,relative_path TEXT,relative_path_key TEXT,filesystem_media_type TEXT,filesystem_size INTEGER,filesystem_mtime_ns INTEGER);`)
			if err != nil {
				t.Fatal(err)
			}
			for i := 1; i <= 12; i++ {
				name := fmt.Sprintf("%d.png", i)
				work := fmt.Sprintf("work-%d", i)
				relative := filepath.Join("author", work)
				if platform == "Venera" {
					relative = work
				}
				if err = os.MkdirAll(filepath.Join(source, relative), 0700); err != nil {
					t.Fatal(err)
				}
				file := filepath.Join(source, relative, name)
				if err = os.WriteFile(file, []byte("synthetic"), 0600); err != nil {
					t.Fatal(err)
				}
				st, _ := os.Stat(file)
				if _, err = db.Exec(`INSERT INTO works VALUES (?,?,?,?,?)`, i, platform, relative, relative, i); err != nil {
					t.Fatal(err)
				}
				if _, err = db.Exec("INSERT INTO media VALUES (?,?,?,?,'image',?,?)", i, i, name, name, st.Size(), st.ModTime().UnixNano()); err != nil {
					t.Fatal(err)
				}
			}
			config := instance.Config{InstanceRoot: root, CacheRoot: filepath.Join(root, "cache"), TempRoot: filepath.Join(root, "temp"), LiveUpdates: true, Sources: map[string]string{platform: source}}
			c, err := NewCache(config, "")
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			var calls atomic.Int64
			entered := make(chan struct{}, 16)
			release := make(chan struct{}, 16)
			c.mu.Lock()
			c.scanning = true
			c.render = func(ctx context.Context, _ File, _, _ string) (imaging.Preview, error) {
				calls.Add(1)
				entered <- struct{}{}
				select {
				case <-ctx.Done():
					return imaging.Preview{}, ctx.Err()
				case <-release:
					return imaging.Preview{Width: 1, Height: 1, Hash: []byte{1}, Original: true}, nil
				}
			}
			c.mu.Unlock()
			if err = c.InitializePreload(config); err != nil {
				t.Fatal(err)
			}
			time.Sleep(20 * time.Millisecond)
			if calls.Load() != 0 {
				t.Fatal("preload read during scan")
			}
			c.SetScanning(false)
			time.Sleep(20 * time.Millisecond)
			if calls.Load() != 0 {
				t.Fatal("scan completion started a cover task")
			}
			if err = c.StartPreloadTask(context.Background(), PreloadRequest{Mode: "incremental", Platforms: []string{platform}, AllowNative: true}); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("preload did not start")
				}
			}
			paused := make(chan struct{})
			go func() { c.SetScanning(true); close(paused) }()
			select {
			case <-paused:
				t.Fatal("scan overlapped an active background read")
			case <-time.After(20 * time.Millisecond):
			}
			release <- struct{}{}
			release <- struct{}{}
			select {
			case <-paused:
			case <-time.After(time.Second):
				t.Fatal("scan pause deadlocked behind a queued preview")
			}
			before := calls.Load()
			time.Sleep(20 * time.Millisecond)
			if calls.Load() != before {
				t.Fatal("preload kept reading during scan")
			}
			for range 12 {
				release <- struct{}{}
			}
			c.SetScanning(false)
			if err = c.PausePreload(false); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(3 * time.Second)
			for {
				status, err := c.PreloadStatus(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if status["completed"] == int64(12) {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("preload incomplete", status)
				}
				time.Sleep(time.Millisecond)
			}
			if err = c.PausePreload(true); err != nil {
				t.Fatal(err)
			}
			// Deletion follows committed catalog facts even when the physical source
			// is still present. Pruning must never walk or remove the source tree.
			if _, err = db.Exec("UPDATE works SET cover_media_id=NULL WHERE work_id=1; DELETE FROM media WHERE media_id=1"); err != nil {
				t.Fatal(err)
			}
			result, err := c.index.prune(context.Background(), config, true)
			if err != nil {
				t.Fatal(err)
			}
			if result["removed"] != int64(1) {
				t.Fatal("removed media derivative retained", result)
			}
			if _, err = os.Stat(filepath.Join(source, func() string {
				if platform == "Venera" {
					return "work-1"
				}
				return filepath.Join("author", "work-1")
			}(), "1.png")); err != nil {
				t.Fatal("source was touched", err)
			}
			if err = c.Close(); err != nil {
				t.Fatal(err)
			}
			c, err = NewCache(config, "")
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			if err = c.InitializePreload(config); err != nil {
				t.Fatal(err)
			}
			status, err := c.PreloadStatus(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if status["completed"] != int64(12) || status["paused"] != true {
				t.Fatal("lost resumable progress", status)
			}

		})
	}
}
