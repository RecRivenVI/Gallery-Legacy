package main

import (
	"compress/gzip"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestCPUProfileOwnedOutput(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "state")
	if e := os.Mkdir(dir, 0700); e != nil {
		t.Fatal(e)
	}
	stop, e := startCPUProfile(library.Config{InstanceRoot: root, TestOnly: true})
	if e != nil {
		t.Fatal(e)
	}
	if e = stop(); e != nil {
		t.Fatal(e)
	}
	files, e := filepath.Glob(filepath.Join(dir, "scan-*.cpu"))
	if e != nil || len(files) != 1 {
		t.Fatal("missing owned profile", e)
	}
	f, e := os.Open(files[0])
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	z, e := gzip.NewReader(f)
	if e != nil {
		t.Fatal(e)
	}
	defer z.Close()
	data, e := io.ReadAll(z)
	if e != nil || len(data) == 0 {
		t.Fatal("invalid CPU profile", e)
	}
}

func TestCPUProfileRequiresOwnedDirectory(t *testing.T) {
	root := t.TempDir()
	for _, c := range []library.Config{
		{InstanceRoot: root},
		{InstanceRoot: "relative", TestOnly: true},
		{InstanceRoot: root, TestOnly: true},
	} {
		if _, e := startCPUProfile(c); e == nil {
			t.Fatal("accepted unavailable profile destination")
		}
	}
	if e := os.WriteFile(filepath.Join(root, "state"), []byte("synthetic"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := startCPUProfile(library.Config{InstanceRoot: root, TestOnly: true}); e == nil {
		t.Fatal("accepted non-directory destination")
	}
}
