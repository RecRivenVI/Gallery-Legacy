package library

import (
	"context"
	"fmt"
	"golang.org/x/sys/windows"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// Compare bounded concurrency with precisely the same fresh checks and inputs.
// No device classifications or runtime limits are changed by this benchmark.
func BenchmarkConcurrentVerifiedObservation(b *testing.B) {
	root := b.TempDir()
	paths := make([]string, 256)
	for i := range paths {
		paths[i] = fmt.Sprintf("synthetic-author/work-%06d", i)
		dir := filepath.Join(root, paths[i])
		if e := os.MkdirAll(dir, 0700); e != nil {
			b.Fatal(e)
		}
		for _, name := range []string{"1.png", "2.png", "10.png", "metadata.json"} {
			if e := os.WriteFile(filepath.Join(dir, name), []byte(`{"title":"合成并发观察"}`), 0600); e != nil {
				b.Fatal(e)
			}
		}
	}
	for _, workers := range []int{1, 2, 4, 8, 16} {
		b.Run(fmt.Sprint(workers), func(b *testing.B) {
			var next atomic.Int64
			var wg sync.WaitGroup
			errors := make(chan error, workers)
			b.ResetTimer()
			for worker := 0; worker < workers; worker++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for {
						n := next.Add(1) - 1
						if n >= int64(b.N) {
							return
						}
						rel := paths[n%int64(len(paths))]
						var meta Entry
						d, e := ReadDirectory(context.Background(), "微博", root, rel, func(entries []Entry) error {
							for _, entry := range entries {
								if entry.Name == "metadata.json" {
									meta = entry
								}
							}
							return nil
						})
						if e == nil {
							_, _, e = ReadListedSource(root, filepath.Join(root, rel, "metadata.json"), 1<<20, meta.Size, meta.Mtime)
						}
						if e == nil {
							e = d.VerifyLeaf()
						}
						if e != nil {
							errors <- e
							return
						}
					}
				}()
			}
			wg.Wait()
			b.StopTimer()
			close(errors)
			for e := range errors {
				b.Fatal(e)
			}
			b.ReportAllocs()
		})
	}
}

// Isolate verified standard-library enumeration and metadata reads from SQL.
// All files are created here; no real root or existing corpus is accepted.
func BenchmarkVerifiedSourceObservation(b *testing.B) {
	root := b.TempDir()
	paths := make([]string, 256)
	raw := []byte(`{"text":"` + strings.Repeat("synthetic 合成 ", 256) + `"}`)
	for i := range paths {
		paths[i] = fmt.Sprintf("synthetic-author/work-%06d", i)
		dir := filepath.Join(root, paths[i])
		if e := os.MkdirAll(dir, 0700); e != nil {
			b.Fatal(e)
		}
		for _, name := range []string{"1.png", "2.png", "10.png", "metadata.json"} {
			data := []byte("synthetic eligible media")
			if name == "metadata.json" {
				data = raw
			}
			if e := os.WriteFile(filepath.Join(dir, name), data, 0600); e != nil {
				b.Fatal(e)
			}
		}
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		rel := paths[n%len(paths)]
		var meta Entry
		d, e := ReadDirectory(context.Background(), "微博", root, rel, func(entries []Entry) error {
			for _, entry := range entries {
				if entry.Name == "metadata.json" {
					meta = entry
				}
			}
			return nil
		})
		if e != nil {
			b.Fatal(e)
		}
		if _, _, e = ReadListedSource(root, filepath.Join(root, rel, "metadata.json"), 1<<20, meta.Size, meta.Mtime); e != nil {
			b.Fatal(e)
		}
		if e = d.VerifyLeaf(); e != nil {
			b.Fatal(e)
		}
	}
	b.ReportAllocs()
}

// Attribute the verified observation cost without relaxing the runtime path.
// Raw enumeration is a measurement reference only and never a scan provider.
func BenchmarkDirectoryCostParts(b *testing.B) {
	root := b.TempDir()
	paths := make([]string, 64)
	for i := range paths {
		paths[i] = fmt.Sprintf("synthetic 作者/nested folder/work-%06d", i)
		dir := filepath.Join(root, paths[i])
		if e := os.MkdirAll(dir, 0700); e != nil {
			b.Fatal(e)
		}
		for _, name := range []string{"1.png", "2.png", "10.png", "metadata.json"} {
			if e := os.WriteFile(filepath.Join(dir, name), []byte(`{"title":"合成观察"}`), 0600); e != nil {
				b.Fatal(e)
			}
		}
	}
	for _, part := range []string{"raw-directory", "ancestor-check", "handle-check", "verified-directory", "verified-metadata"} {
		b.Run(part, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				rel := paths[i%len(paths)]
				dir := filepath.Join(root, rel)
				switch part {
				case "raw-directory":
					f, e := os.Open(dir)
					if e != nil {
						b.Fatal(e)
					}
					entries, e := f.ReadDir(256)
					f.Close()
					if e != nil && e != io.EOF {
						b.Fatal(e)
					}
					if len(entries) != 4 {
						b.Fatal("incomplete reference")
					}
				case "ancestor-check":
					if _, e := ObserveDirectory(dir); e != nil {
						b.Fatal(e)
					}
				case "handle-check":
					f, e := os.Open(dir)
					if e != nil {
						b.Fatal(e)
					}
					e = verifyDirectoryHandle(f, root, dir)
					f.Close()
					if e != nil {
						b.Fatal(e)
					}
				case "verified-directory":
					if _, e := ReadDirectory(context.Background(), "微博", root, rel, func(entries []Entry) error { return nil }); e != nil {
						b.Fatal(e)
					}
				case "verified-metadata":
					file := filepath.Join(dir, "metadata.json")
					st, e := os.Stat(file)
					if e != nil {
						b.Fatal(e)
					}
					if _, _, e = ReadListedSource(root, file, 1<<20, st.Size(), st.ModTime().UnixNano()); e != nil {
						b.Fatal(e)
					}
				}
			}
		})
	}
}

// Compare equally fresh complete ancestor checks, without changing runtime
// behavior. Only attributes are needed for this check, not sizes or timestamps.
func BenchmarkAncestorAttributes(b *testing.B) {
	root := b.TempDir()
	path := filepath.Join(root, "synthetic 作者", "work")
	if e := os.MkdirAll(path, 0700); e != nil {
		b.Fatal(e)
	}
	for _, fullInfo := range []bool{true, false} {
		b.Run(fmt.Sprint(fullInfo), func(b *testing.B) {
			b.ReportAllocs()
			for n := 0; n < b.N; n++ {
				at := path
				for {
					if fullInfo {
						st, e := os.Lstat(at)
						if e != nil || st.Mode()&os.ModeSymlink != 0 {
							b.Fatal("ancestor unavailable", e)
						}
					} else {
						p, e := windows.UTF16PtrFromString(at)
						if e != nil {
							b.Fatal(e)
						}
						attributes, e := windows.GetFileAttributes(p)
						if e != nil || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
							b.Fatal("ancestor unavailable", e)
						}
					}
					next := filepath.Dir(at)
					if next == at {
						break
					}
					at = next
				}
			}
		})
	}
}
