package library

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A directory observation is a bounded membership snapshot, not a guarantee
// that arbitrary file contents cannot change after they have been observed.
type Directory struct {
	Path string
	Info os.FileInfo
}

// Nested parts of one directory observation, excluding the consumer callback.
// Timings are local to the caller; no synchronization or per-entry timer occurs.
type DirectoryCosts struct {
	Open, Read, Map, Verify             time.Duration
	ReadBatches, Entries, Verifications int64
}

func (d Directory) Verify() error {
	now, e := ObserveDirectory(d.Path)
	if e != nil || !os.SameFile(d.Info, now) || !d.Info.ModTime().Equal(now.ModTime()) {
		return errors.New("DIRECTORY_CHANGED_DURING_SCAN")
	}
	return nil
}

// All observed work directories are checked individually after metadata reads.
// The root and author retain their full ancestor check before their scope seals.
func (d Directory) VerifyLeaf() error {
	now, e := observeDirectoryLeaf(d.Path)
	if e != nil || now.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 || !now.IsDir() ||
		!os.SameFile(d.Info, now) || !d.Info.ModTime().Equal(now.ModTime()) {
		return errors.New("DIRECTORY_CHANGED_DURING_SCAN")
	}
	return nil
}

func NativeEntry(platform, relative string, st os.FileInfo) Entry {
	relative = strings.ReplaceAll(relative, string(filepath.Separator), "\\")
	key := strings.ToLower(relative)
	author, _, _ := strings.Cut(key, "\\")
	parent, work := ".", ""
	if last := strings.LastIndexByte(key, '\\'); last >= 0 {
		parent, work = key[:last], key
		first := strings.IndexByte(key, '\\')
		if next := strings.IndexByte(key[first+1:], '\\'); next >= 0 {
			work = key[:first+1+next]
		}
	}
	kind, size := "file", st.Size()
	if st.IsDir() {
		kind, size = "folder", 0
	}
	return Entry{platform, key, relative, parent, kind, author, work, st.Name(), size, st.ModTime().UnixNano()}
}

// ReadDir uses Go's standard directory enumerator in batches. On Windows,
// DirEntry.Info uses attributes returned by enumeration; it does not Lstat
// every child. The opened handle and ancestor checks are still verified.
func ReadDirectory(ctx context.Context, platform, root, relative string, accept func([]Entry) error) (Directory, error) {
	return ReadDirectoryMeasured(ctx, platform, root, relative, accept, nil)
}

func ReadDirectoryMeasured(ctx context.Context, platform, root, relative string, accept func([]Entry) error, costs *DirectoryCosts) (Directory, error) {
	started := time.Now()
	path := root
	var e error
	if relative != "" && relative != "." {
		path, e = Join(root, relative)
		if e != nil {
			return Directory{}, e
		}
	}
	if e = ctx.Err(); e != nil {
		return Directory{}, e
	}
	f, before, e := openDirectory(root, path)
	if costs != nil {
		costs.Open += time.Since(started)
	}
	if e != nil {
		return Directory{}, e
	}
	defer f.Close()
	d := Directory{path, before}
	// Resolve the already verified directory once. Every child name comes from
	// ReadDir, so rebuilding an absolute path and Rel for each entry is redundant.
	prefix, e := filepath.Rel(root, path)
	if e != nil {
		return d, e
	}
	if prefix == "." {
		prefix = ""
	} else {
		prefix += string(filepath.Separator)
	}
	for {
		if e = ctx.Err(); e != nil {
			return d, e
		}
		started = time.Now()
		children, readError := f.ReadDir(256)
		if costs != nil {
			costs.Read += time.Since(started)
			costs.ReadBatches++
		}
		started = time.Now()
		batch, e := directoryEntries(platform, prefix, children)
		if costs != nil {
			costs.Map += time.Since(started)
			costs.Entries += int64(len(batch))
		}
		if e != nil {
			return d, e
		}
		if len(batch) > 0 {
			if e = accept(batch); e != nil {
				return d, e
			}
		}
		if readError == io.EOF {
			break
		}
		if readError != nil {
			return d, errors.New("FILESYSTEM_INCOMPLETE")
		}
	}
	if e = ctx.Err(); e != nil {
		return d, e
	}
	started = time.Now()
	if costs != nil {
		costs.Verifications++
	}
	defer func() {
		if costs != nil {
			costs.Verify += time.Since(started)
		}
	}()
	after, e := f.Stat()
	if e != nil || !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		return d, errors.New("DIRECTORY_CHANGED_DURING_SCAN")
	}
	// Verify the enumerated handle's path, rather than restatting its complete
	// ancestor chain twice. Scope sealing still rechecks root/author ancestry.
	return d, verifyDirectoryHandle(f, root, path)
}

func directoryEntries(platform, prefix string, children []os.DirEntry) ([]Entry, error) {
	batch := make([]Entry, 0, len(children))
	for _, child := range children {
		st, e := child.Info()
		if e != nil {
			return nil, errors.New("FILESYSTEM_INCOMPLETE")
		}
		if st.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			return nil, errors.New("PATH_REPARSE")
		}
		if !st.IsDir() && !st.Mode().IsRegular() {
			return nil, errors.New("FILESYSTEM_INCOMPLETE")
		}
		batch = append(batch, NativeEntry(platform, prefix+child.Name(), st))
	}
	return batch, nil
}

func (l *Listing) PutNative(ctx context.Context, entries []Entry) error {
	if e := l.put(ctx, entries); e != nil {
		return e
	}
	l.Entries.Add(int64(len(entries)))
	return nil
}

// Parent enumeration may have an older directory timestamp. Refresh the
// existing membership row from the directory's own verified handle, without
// allowing duplicate child entries or replacing a file with a directory.
func (l *Listing) RefreshDirectory(ctx context.Context, platform, relative string, d Directory) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	started := time.Now()
	defer func() { l.WriteNanos.Add(time.Since(started).Nanoseconds()) }()
	key := strings.ToLower(relative)
	if key == "." {
		_, e := l.DB.ExecContext(ctx, "INSERT INTO entries("+entryColumns+") VALUES (?,'.','.','','folder',0,?,'','','')", platform, d.Info.ModTime().UnixNano())
		if e == nil {
			l.Entries.Add(1)
			l.Transactions.Add(1)
		}
		return e
	}
	r, e := l.DB.ExecContext(ctx, "UPDATE entries SET mtime=? WHERE platform=? AND key=? AND kind='folder'", d.Info.ModTime().UnixNano(), platform, key)
	if e != nil {
		return e
	}
	n, e := r.RowsAffected()
	if e != nil || n != 1 {
		return errors.New("FILESYSTEM_INCOMPLETE")
	}
	l.Transactions.Add(1)
	return nil
}
