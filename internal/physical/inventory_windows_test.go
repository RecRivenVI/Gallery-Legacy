package physical

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"golang.org/x/sys/windows"
)

func TestRawRecordRestoresUpdateSequence(t *testing.T) {
	record := make([]byte, 1024)
	record[4], record[6] = 48, 3
	record[48], record[50], record[52] = 9, 15, 24
	record[510], record[1022] = 9, 9
	if err := repairRecord(record); err != nil || record[510] != 15 || record[1022] != 24 {
		t.Fatalf("repair raw record: %v", err)
	}
	if err := repairRecord(record); err == nil {
		t.Fatal("logical or torn record was accepted as raw")
	}
}

func TestNTFSInventoryAgainstNative(t *testing.T) {
	base := os.Getenv("GALLERY_NTFS_SYNTHETIC_ROOT")
	if base == "" {
		t.Skip("requires an isolated SSD NTFS directory")
	}
	dir, err := os.MkdirTemp(base, "ntfs-table-")
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "source")
	for _, sub := range []string{"state", "source/author/work/nested", "source/other/work"} {
		if err = os.MkdirAll(filepath.Join(dir, sub), 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(root, "author/work/metadata.json")
	if err = os.WriteFile(file, []byte(`{"id":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "author/work/nested/alias.json")
	if err = os.Link(file, alias); err != nil {
		t.Fatal(err)
	}
	for i := range 22 {
		link := filepath.Join(root, "author/work/nested", fmt.Sprintf("extended-hard-link-%02d.json", i))
		if err = os.Link(file, link); err != nil {
			t.Fatal(err)
		}
	}
	makeStorage := func(name string, ioctl uint32, data []byte) {
		t.Helper()
		f, err := os.Create(filepath.Join(root, "author/work", name))
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		var input *byte
		if len(data) > 0 {
			input = &data[0]
		}
		var written uint32
		if err = windows.DeviceIoControl(windows.Handle(f.Fd()), ioctl, input, uint32(len(data)), nil, 0, &written, nil); err != nil {
			t.Fatal(err)
		}
		if len(data) == 0 {
			if err = f.Truncate(2 << 20); err != nil {
				t.Fatal(err)
			}
		} else if _, err = f.Write(bytes.Repeat([]byte{'a'}, 2<<20)); err != nil {
			t.Fatal(err)
		}
	}
	makeStorage("sparse.png", 0x900c4, nil)              // FSCTL_SET_SPARSE
	makeStorage("compressed.png", 0x9c040, []byte{1, 0}) // FSCTL_SET_COMPRESSION
	ctx := context.Background()
	scope := TableScope{"pixiv", root, "author"}
	check := func(incremental bool) {
		t.Helper()
		if err := RefreshTable(ctx, dir, []TableScope{scope}, incremental); err != nil {
			t.Fatal(err)
		}
		db, err := tableStore(ctx, dir)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		bound, err := resolveScopes([]TableScope{scope})
		if err != nil {
			t.Fatal(err)
		}
		s, err := loadSnapshot(ctx, db, bound[0], false)
		if err != nil {
			t.Fatal(err)
		}
		count := 1 // scope root
		for _, relative := range []string{`author`, `author\work`, `author\work\nested`} {
			_, err = library.ReadDirectory(ctx, "pixiv", root, relative, func(entries []library.Entry) error {
				for _, e := range entries {
					count++
					row, ok := s.rows[e.Key]
					size, mtime := e.Size, e.Mtime
					if e.Kind == "folder" {
						info, err := library.ObserveDirectory(filepath.Join(root, e.Relative))
						if err != nil {
							return err
						}
						mtime = info.ModTime().UnixNano()
					} else if filepath.Ext(e.Relative) == ".json" {
						// NTFS can retain stale directory-index attributes for
						// secondary hard links. Compare the opened file itself.
						info, err := os.Stat(filepath.Join(root, e.Relative))
						if err != nil {
							return err
						}
						size, mtime = info.Size(), info.ModTime().UnixNano()
					}
					if !ok || row.Relative != e.Relative || row.Directory != (e.Kind == "folder") || row.Size != size || row.Mtime != mtime {
						t.Errorf("fact mismatch for synthetic %s: table=%+v native=%+v", e.Key, row, e)
					}
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		}
		count++ // selected author folder
		if len(s.rows) != count {
			t.Fatalf("scope membership %d, want %d", len(s.rows), count)
		}
		l, err := library.NewListing(filepath.Join(dir, "temp"))
		if err != nil {
			t.Fatal(err)
		}
		defer l.Close()
		if err = l.PrepareScheduleTables(ctx); err != nil {
			t.Fatal(err)
		}
		n, err := l.LoadFileTable(ctx, dir, "pixiv", root, "author", true)
		if err != nil || int(n) != count {
			t.Fatalf("load table listing: count=%d error=%v", n, err)
		}
		var rel, work string
		err = l.DB.QueryRow("SELECT relative,work FROM entries WHERE key=?", `author\work\metadata.json`).Scan(&rel, &work)
		if err != nil || rel != `author\work\metadata.json` || work != `author\work` {
			t.Fatalf("bad listing membership: %s %s %v", rel, work, err)
		}
		if err := l.BuildSchedule(ctx, "pixiv", "author", true); err != nil {
			t.Fatal(err)
		}
		page, _, err := l.ScheduledPage(ctx, "pixiv", 0)
		if err != nil || len(page) != 1 || page[0].Metadata == nil {
			t.Fatalf("missing resident metadata scheduling hint: %v", err)
		}
	}
	if err = RefreshTable(ctx, dir, []TableScope{{Platform: "pixiv", Root: root}}, false); err != nil {
		t.Fatal(err)
	}
	check(true)
	if err = os.WriteFile(file, []byte(`{"id":123456789}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(alias, filepath.Join(root, "author/work/nested/renamed.json")); err != nil {
		t.Fatal(err)
	}
	check(true)
	check(true)
	if err = os.Rename(filepath.Join(root, "author/work/nested"), filepath.Join(root, "other/work/moved")); err != nil {
		t.Fatal(err)
	}
	if err = RefreshTable(ctx, dir, []TableScope{scope}, true); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(root, "other/work/moved"), filepath.Join(root, "author/work/nested")); err != nil {
		t.Fatal(err)
	}
	check(true)
	reparse := filepath.Join(root, "author/work/foreign")
	if err = os.Symlink(filepath.Join(root, "other/work"), reparse); err != nil {
		t.Fatal(err)
	}
	if err = RefreshTable(ctx, dir, []TableScope{scope}, true); err == nil || !strings.Contains(err.Error(), "NTFS_SCOPE_REPARSE_OR_INVALID") {
		t.Fatalf("reparse point must require explicit fallback: %v", err)
	}
	if err = os.Remove(reparse); err != nil {
		t.Fatal(err)
	}
	check(true)
}
