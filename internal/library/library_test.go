package library

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"os"
	"path/filepath"
	"testing"
)

func TestPathAndLeaseSafety(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{`..\outside`, `C:\outside`, `foo\..\outside`, `foo:stream`, `foo\bar\..`} {
		if _, e := Join(root, p); e == nil {
			t.Fatalf("accepted escape %s", p)
		}
	}
	release, e := Lease(filepath.Join(root, "scan.lock"))
	if e != nil {
		t.Fatal(e)
	}
	if next, e := Lease(filepath.Join(root, "scan.lock")); e == nil {
		next()
		t.Fatal("second writer lease allowed")
	}
	release()
	release, e = Lease(filepath.Join(root, "scan.lock"))
	if e != nil {
		t.Fatal(e)
	}
	release()
}
func TestNativeReadIsReadonlyAndRejectsLinks(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "metadata.json")
	if e := os.WriteFile(file, []byte(`{"synthetic":true}`), 0600); e != nil {
		t.Fatal(e)
	}
	before, _ := os.Stat(file)
	b, after, e := ReadSource(root, file, 1024)
	if e != nil || string(b) != `{"synthetic":true}` || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("readonly read mismatch", e)
	}
	if _, _, e = ReadSource(root, file, 2); e == nil {
		t.Fatal("metadata limit ignored")
	}
	if _, _, e = ReadSource(root, filepath.Join(filepath.Dir(root), "outside"), 1024); e == nil {
		t.Fatal("escape read allowed")
	}
}

func TestListedMetadataChecksOpenedHandleBeforeReading(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "metadata.json")
	raw := []byte(`{"synthetic":true}`)
	if e := os.WriteFile(file, raw, 0600); e != nil {
		t.Fatal(e)
	}
	st, _ := os.Stat(file)
	b, observed, e := ReadListedSource(root, file, 1024, st.Size(), st.ModTime().UnixNano())
	if e != nil || string(b) != string(raw) || observed.Size() != st.Size() {
		t.Fatal("listed read mismatch", e)
	}
	for _, attrs := range [][2]int64{{st.Size() + 1, st.ModTime().UnixNano()}, {st.Size(), st.ModTime().UnixNano() + 100}} {
		b, _, e = ReadListedSource(root, file, 1024, attrs[0], attrs[1])
		if e == nil || e.Error() != "METADATA_CHANGED_SINCE_LISTING" || len(b) != 0 {
			t.Fatal("stale listing consumed bytes", e)
		}
	}
	b, observed, e = ReadListedSource(root, file, 2, st.Size(), st.ModTime().UnixNano())
	if e == nil || e.Error() != "METADATA_TOO_LARGE" || len(b) != 0 || observed == nil {
		t.Fatal("oversize metadata must retain native facts without reading", e)
	}
	after, _ := os.Stat(file)
	if !st.ModTime().Equal(after.ModTime()) || st.Size() != after.Size() {
		t.Fatal("source modified")
	}
}

func TestObserveDirectoryChecksLeafAndParentsWithoutCaching(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "author", "work")
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	if st, e := ObserveDirectory(dir); e != nil || !st.IsDir() {
		t.Fatal("directory unavailable", e)
	}
	if e := os.Remove(dir); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(dir, []byte("not a directory"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := ObserveDirectory(dir); e == nil {
		t.Fatal("cached directory accepted replacement file")
	}
	outside := t.TempDir()
	link := filepath.Join(root, "linked")
	if e := os.Symlink(outside, link); e != nil {
		t.Fatal("synthetic symlink setup failed", e)
	}
	if _, e := ObserveDirectory(link); e == nil {
		t.Fatal("reparse directory accepted")
	}
	if e := os.Mkdir(filepath.Join(outside, "child"), 0700); e != nil {
		t.Fatal(e)
	}
	if _, e := ObserveDirectory(filepath.Join(link, "child")); e == nil {
		t.Fatal("reparse parent accepted")
	}
}
func TestMetadataExactAllocationPreservesSizeLimits(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "metadata.json")
	for _, size := range []int{0, 1, 512, 8192, 1048576} {
		want := bytes.Repeat([]byte("x"), size)
		if e := os.WriteFile(file, want, 0600); e != nil {
			t.Fatal(e)
		}
		st, e := os.Stat(file)
		if e != nil {
			t.Fatal(e)
		}
		got, after, e := ReadListedSource(root, file, int64(size+1), st.Size(), st.ModTime().UnixNano())
		if e != nil || !bytes.Equal(want, got) || after.Size() != int64(size) {
			t.Fatal("exact read changed", size, e)
		}
		if size > 0 {
			if _, _, e := ReadListedSource(root, file, int64(size-1), st.Size(), st.ModTime().UnixNano()); e == nil {
				t.Fatal("size limit bypassed", size)
			}
		}
	}
}

func TestConfigRejectsRuntimeSourceOverlap(t *testing.T) {
	root := t.TempDir()
	instance := filepath.Join(root, "instance")
	os.MkdirAll(instance, 0700)
	sources := map[string]string{}
	for id := range metadata.Versions {
		sources[id] = filepath.Join(root, "sources", id)
	}
	c := Config{InstanceRoot: instance, Database: filepath.Join(instance, "live", "catalog.sqlite"), Sources: sources, TestOnly: true}
	file := filepath.Join(instance, "go.json")
	write := func() { b, _ := json.Marshal(c); os.WriteFile(file, b, 0600) }
	write()
	if _, e := Load(file); e != nil {
		t.Fatal(e)
	}
	c.Sources["pixiv"] = root
	write()
	if _, e := Load(file); e == nil {
		t.Fatal("runtime/source overlap accepted")
	}
	c.Sources["pixiv"] = filepath.Join(root, "sources", "pixiv")
	c.ListingSource = "everything"
	write()
	if _, e := Load(file); e == nil {
		t.Fatal("retired listing provider accepted")
	}
}

func TestListingMembershipBatchesKeysAndSeparatesPlatforms(t *testing.T) {
	l, e := NewListing(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	if e = l.put(context.Background(), []Entry{{Platform: "pixiv", Key: "a", Kind: "folder"}, {Platform: "X", Key: "b", Kind: "folder"}, {Platform: "pixiv", Key: "file", Kind: "file"}}); e != nil {
		t.Fatal(e)
	}
	keys := []string{"a", "b", "file"}
	for i := 0; i < 600; i++ {
		keys = append(keys, "absent")
	}
	found, e := l.Membership(context.Background(), "pixiv", keys)
	if e != nil {
		t.Fatal(e)
	}
	if len(found) != 1 || !found["a"] {
		t.Fatal("membership crossed platform or included non-folder")
	}
	if found, e = l.Membership(context.Background(), "pixiv", nil); e != nil || len(found) != 0 {
		t.Fatal("empty membership failed", e)
	}
}

func TestMembershipListingBatchesSignaturesAndHashesIndependentOfFinishOrder(t *testing.T) {
	ctx := context.Background()
	build := func(reverse bool) (string, int64) {
		l, e := NewListing(t.TempDir())
		if e != nil {
			t.Fatal(e)
		}
		defer l.Close()
		entries := []Entry{{Platform: "pixiv", Key: "author", Relative: "author", Kind: "folder", Mtime: 1}}
		for i := 0; i < 1000; i++ {
			key := fmt.Sprintf("author\\work-%04d", i)
			entries = append(entries, Entry{Platform: "pixiv", Key: key, Relative: key, Parent: "author", Kind: "folder", Mtime: 1})
		}
		if e = l.PutNative(ctx, entries); e != nil {
			t.Fatal(e)
		}
		for i := 0; i < 1000; i++ {
			index := i
			if reverse {
				index = 999 - i
			}
			key := fmt.Sprintf("author\\work-%04d", index)
			if e = l.RecordSignature(ctx, "pixiv", key, fmt.Sprint(index)); e != nil {
				t.Fatal(e)
			}
		}
		signature, e := l.AuthorSignature(ctx, "pixiv", "author")
		if e != nil {
			t.Fatal(e)
		}
		if l.Entries.Load() != 1001 || l.Transactions.Load() != 3 {
			t.Fatal("tiny signature transactions", l.Transactions.Load())
		}
		// Internal media membership is deliberately not duplicated in scratch SQL.
		found, e := l.Membership(ctx, "pixiv", []string{"author\\work-0000", "author\\work-0000\\1.png"})
		if e != nil || len(found) != 1 {
			t.Fatal("membership changed", e)
		}
		if e = l.RecordSignature(ctx, "pixiv", "author\\work-0000", "changed"); e != nil {
			t.Fatal(e)
		}
		changed, e := l.AuthorSignature(ctx, "pixiv", "author")
		if e != nil || changed == signature {
			t.Fatal("work fingerprint not reflected", e)
		}
		return signature, l.Transactions.Load()
	}
	first, _ := build(false)
	second, _ := build(true)
	if first != second {
		t.Fatal("completion order changed author identity")
	}
}

func TestRetiredProviderConfigIsRejectedEvenWhenFilesystemSelected(t *testing.T) {
	root := t.TempDir()
	instance := filepath.Join(root, "instance")
	os.Mkdir(instance, 0700)
	c := Config{TestOnly: true, InstanceRoot: instance, Database: filepath.Join(instance, "live", "catalog.sqlite"), Sources: map[string]string{}}
	for id := range metadata.Versions {
		c.Sources[id] = filepath.Join(root, "sources", id)
	}
	raw, _ := json.Marshal(c)
	var fields map[string]any
	json.Unmarshal(raw, &fields)
	file := filepath.Join(instance, "config.json")
	os.WriteFile(file, raw, 0600)
	if loaded, e := Load(file); e != nil || loaded.ListingSource != "filesystem" {
		t.Fatal("native default missing", e)
	}
	fields["everything"] = "http://127.0.0.1:54321/"
	raw, _ = json.Marshal(fields)
	os.WriteFile(file, raw, 0600)
	if _, e := Load(file); e == nil || e.Error() != "CONFIG_FIELD_UNSUPPORTED" {
		t.Fatal("retired provider silently accepted", e)
	}
}

func TestSlowDeviceBudgetIsExplicitBoundedAndConservativeByDefault(t *testing.T) {
	root := t.TempDir()
	instance := filepath.Join(root, "instance")
	if e := os.Mkdir(instance, 0700); e != nil {
		t.Fatal(e)
	}
	c := Config{TestOnly: true, InstanceRoot: instance, Database: filepath.Join(instance, "live", "catalog.sqlite"), Sources: map[string]string{}}
	for id := range metadata.Versions {
		c.Sources[id] = filepath.Join(root, "sources", id)
	}
	file := filepath.Join(instance, "config.json")
	for _, workers := range []int{0, 1, 2, 4, 8, -1, 9} {
		c.SlowDeviceWorkers = workers
		raw, e := json.Marshal(c)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(file, raw, 0600); e != nil {
			t.Fatal(e)
		}
		loaded, e := Load(file)
		if workers < 0 || workers > 8 {
			if e == nil || e.Error() != "BUDGET_INVALID" {
				t.Fatal("unbounded device budget accepted", workers, e)
			}
			continue
		}
		expected := workers
		if expected == 0 {
			expected = 2
		}
		if e != nil || loaded.SlowDeviceWorkers != expected || loaded.Workers != 8 || loaded.BatchSize != 128 {
			t.Fatal("unrelated budgets or conservative default changed", workers, e)
		}
	}
}
