package library

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFinalHandlePathGrowthAndClosedHandle(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "synthetic 合成 folder")
	if e := os.Mkdir(dir, 0700); e != nil {
		t.Fatal(e)
	}
	f, e := os.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	h := windows.Handle(f.Fd())
	large, e := finalHandlePathBuffer(h, make([]uint16, 32768))
	if e != nil {
		t.Fatal(e)
	}
	for _, size := range []int{2, 8, 1024} {
		got, e := finalHandlePathBuffer(h, make([]uint16, size))
		if e != nil || got != large || !strings.EqualFold(filepath.Clean(got), dir) {
			t.Fatal("normalized handle path changed", size, e)
		}
	}
	if e = f.Close(); e != nil {
		t.Fatal(e)
	}
	if _, e = finalHandlePath(h); e == nil || e.Error() != "SOURCE_HANDLE_UNVERIFIABLE" {
		t.Fatal("closed handle accepted", e)
	}
	long := dir
	for len(long) < 1100 {
		long = filepath.Join(long, strings.Repeat("synthetic", 12))
	}
	if e = os.MkdirAll(long, 0700); e != nil {
		t.Fatal(e)
	}
	f, e = os.Open(long)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	got, e := finalHandlePath(windows.Handle(f.Fd()))
	if e != nil || !strings.EqualFold(filepath.Clean(got), long) {
		t.Fatal("long normalized handle path lost", e)
	}
}

// This reference retains the previous identity mapping, not another scanner.
func referenceNativeEntry(platform, relative string, st os.FileInfo) Entry {
	relative = strings.ReplaceAll(relative, string(filepath.Separator), "\\")
	key := strings.ToLower(relative)
	parts := strings.Split(key, "\\")
	parent, work := ".", ""
	if len(parts) > 1 {
		parent, work = strings.Join(parts[:len(parts)-1], "\\"), strings.Join(parts[:2], "\\")
	}
	kind, size := "file", st.Size()
	if st.IsDir() {
		kind, size = "folder", 0
	}
	return Entry{platform, key, relative, parent, kind, parts[0], work, st.Name(), size, st.ModTime().UnixNano()}
}

func TestDirectoryIdentityMappingAndMeasuredParts(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{".", "Author 合成", "Author 合成/Work MIXED", "Author 合成/Work MIXED/Chapter 10"} {
		dir := filepath.Join(root, rel)
		if e := os.MkdirAll(dir, 0700); e != nil {
			t.Fatal(e)
		}
		for _, name := range []string{"1.PNG", "10.png", "é 日本語.png"} {
			if e := os.WriteFile(filepath.Join(dir, name), []byte("synthetic"), 0600); e != nil {
				t.Fatal(e)
			}
		}
	}
	for _, rel := range []string{".", "Author 合成", `Author 合成\Work MIXED`, "Author 合成/Work MIXED/Chapter 10"} {
		var costs DirectoryCosts
		count := 0
		d, e := ReadDirectoryMeasured(context.Background(), "Venera", root, rel, func(entries []Entry) error {
			for _, entry := range entries {
				abs := filepath.Join(root, strings.ReplaceAll(entry.Relative, "\\", string(filepath.Separator)))
				st, e := os.Lstat(abs)
				if e != nil {
					return e
				}
				previous, e := filepath.Rel(root, abs)
				expected := referenceNativeEntry("Venera", previous, st)
				// Windows parent enumeration can retain an older directory mtime.
				// Its own verified handle refreshes it in the existing pipeline.
				// Compare path mapping here, not two different observations' times.
				if st.IsDir() {
					expected.Mtime = entry.Mtime
				}
				if e != nil || entry != expected {
					t.Fatalf("physical identity changed: %#v != %#v (%v)", entry, expected, e)
				}
				count++
			}
			return nil
		}, &costs)
		// Fast calls may fall within one clock tick. Check that every phase ran,
		// rather than making a correctness test depend on timer resolution.
		if e != nil || count == 0 || d.VerifyLeaf() != nil || costs.Open < 0 || costs.Read < 0 || costs.Map < 0 || costs.Verify < 0 || costs.ReadBatches == 0 || costs.Entries != int64(count) || costs.Verifications != 1 {
			t.Fatal("observation or timing incomplete", e, costs)
		}
	}
}

func TestStandardDirectoryBatchesAndReadonlyAttributes(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 600; i++ {
		if e := os.WriteFile(filepath.Join(root, fmt.Sprintf("合成 %04d.png", i)), []byte("synthetic"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	before, _ := os.Stat(root)
	count, batches := 0, 0
	d, e := ReadDirectory(context.Background(), "pixiv", root, ".", func(batch []Entry) error {
		batches++
		if len(batch) > 256 {
			t.Fatal("unbounded read")
		}
		for _, entry := range batch {
			if entry.Kind != "file" || entry.Size != 9 || entry.Mtime <= 0 || entry.Parent != "." {
				t.Fatal("enumeration attributes lost")
			}
		}
		count += len(batch)
		return nil
	})
	if e != nil || count != 600 || batches != 3 || d.Verify() != nil {
		t.Fatal("incomplete enumeration", e, count, batches)
	}
	after, _ := os.Stat(root)
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("source modified")
	}
}

func TestDirectoryCancellationPartialErrorAndRaceAreIncomplete(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "synthetic.png"), []byte("page"), 0600)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := ReadDirectory(ctx, "X", root, ".", func([]Entry) error { t.Fatal("cancelled read callback"); return nil }); !errors.Is(e, context.Canceled) {
		t.Fatal("cancel ignored", e)
	}
	partial := errors.New("SYNTHETIC_PARTIAL_READ")
	if _, e := ReadDirectory(context.Background(), "X", root, ".", func([]Entry) error { return partial }); !errors.Is(e, partial) {
		t.Fatal("partial callback incorrectly complete", e)
	}
	_, e := ReadDirectory(context.Background(), "X", root, ".", func([]Entry) error {
		future := time.Now().Add(time.Hour)
		return os.Chtimes(root, future, future)
	})
	if e == nil || e.Error() != "DIRECTORY_CHANGED_DURING_SCAN" {
		t.Fatal("membership race accepted", e)
	}
	if _, e = ReadDirectory(context.Background(), "X", root, "..\\outside", func([]Entry) error { return nil }); e == nil {
		t.Fatal("escape allowed")
	}
	if _, e = ReadDirectory(context.Background(), "X", root, "missing", func([]Entry) error { return nil }); e == nil {
		t.Fatal("missing directory complete")
	}
}

func TestDirectoryDoesNotFollowReparseChildrenOrParents(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	link := filepath.Join(root, "linked")
	if e := os.Symlink(outside, link); e != nil {
		t.Fatal(e)
	}
	for _, relative := range []string{".", "linked"} {
		if _, e := ReadDirectory(context.Background(), "Venera", root, relative, func([]Entry) error { return nil }); e == nil {
			t.Fatal("link accepted", relative)
		}
	}
}

func TestFilesystemConfigRequiresNoEverythingAndRejectsUnknownMode(t *testing.T) {
	root := t.TempDir()
	instance := filepath.Join(root, "instance")
	os.Mkdir(instance, 0700)
	c := Config{TestOnly: true, InstanceRoot: instance, Database: filepath.Join(instance, "live", "catalog.sqlite"), ListingSource: "filesystem", Sources: map[string]string{}}
	for id := range metadata.Versions {
		c.Sources[id] = filepath.Join(root, "sources", id)
	}
	file := filepath.Join(instance, "config.json")
	write := func() { b, _ := json.Marshal(c); os.WriteFile(file, b, 0600) }
	write()
	if loaded, e := Load(file); e != nil || loaded.ListingSource != "filesystem" {
		t.Fatal("filesystem required Everything", e)
	}
	c.ListingSource = "automatic-fallback"
	write()
	if _, e := Load(file); e == nil {
		t.Fatal("implicit fallback allowed")
	}
}

func TestEnumerationDetectsRenamedHandleAndLeafReplacement(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "work")
	os.Mkdir(dir, 0700)
	os.WriteFile(filepath.Join(dir, "1.png"), []byte("synthetic"), 0600)
	_, e := ReadDirectory(context.Background(), "pixiv", root, "work", func([]Entry) error {
		return os.Rename(dir, filepath.Join(root, "moved"))
	})
	if e == nil {
		t.Fatal("renamed directory incorrectly complete")
	}
	// Windows may refuse rename while the enumerator is open. That is also
	// fail-closed; finish the synthetic rename after the handle has closed.
	if _, e := os.Stat(filepath.Join(root, "moved")); os.IsNotExist(e) {
		if e = os.Rename(dir, filepath.Join(root, "moved")); e != nil {
			t.Fatal(e)
		}
	}
	d, e := ReadDirectory(context.Background(), "pixiv", root, "moved", func([]Entry) error { return nil })
	if e != nil || d.VerifyLeaf() != nil {
		t.Fatal("leaf unavailable", e)
	}
	if e = os.Rename(filepath.Join(root, "moved"), dir); e != nil {
		t.Fatal(e)
	}
	os.Mkdir(filepath.Join(root, "moved"), 0700)
	if d.VerifyLeaf() == nil {
		t.Fatal("replacement leaf accepted")
	}
}
