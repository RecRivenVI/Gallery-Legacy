package library

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDirectoryIdentityCapturedBeforePathReplacement(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "work")
	if e := os.Mkdir(dir, 0700); e != nil {
		t.Fatal(e)
	}
	before, e := ObserveDirectory(dir)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Rename(dir, filepath.Join(root, "moved")); e != nil {
		t.Fatal(e)
	}
	if e = os.Mkdir(dir, 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.Chtimes(dir, before.ModTime(), before.ModTime()); e != nil {
		t.Fatal(e)
	}
	if f, _, e := openObservedDirectory(root, dir, before); e == nil {
		f.Close()
		t.Fatal("same-mtime replacement accepted after observation")
	}
	d := Directory{Path: dir, Info: before}
	if d.VerifyLeaf() == nil || d.Verify() == nil {
		t.Fatal("replacement identity lost")
	}
}

func TestAncestryRecheckedAfterObservationAndLongPath(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "author")
	dir := filepath.Join(parent, "work")
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	d, e := ReadDirectory(context.Background(), "pixiv", root, "author/work", func([]Entry) error { return nil })
	if e != nil {
		t.Fatal(e)
	}
	moved := filepath.Join(root, "moved")
	if e = os.Rename(parent, moved); e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink(moved, parent); e != nil {
		t.Fatal(e)
	}
	if d.Verify() == nil || NoLinks(dir) == nil {
		t.Fatal("new ancestor link accepted")
	}
	if _, _, e = openDirectory(root, dir); e == nil {
		t.Fatal("enumerator followed new ancestor link")
	}
	long := filepath.Join(root, "long")
	for len(long) < 1100 {
		long = filepath.Join(long, strings.Repeat("synthetic", 12))
	}
	if e = os.MkdirAll(long, 0700); e != nil {
		t.Fatal(e)
	}
	if _, e = ObserveDirectory(long); e != nil {
		t.Fatal("long directory unavailable", e)
	}
	if e = NoLinks(filepath.Join(long, "not-yet-created")); e != nil {
		t.Fatal("safe absent leaf rejected", e)
	}
}
