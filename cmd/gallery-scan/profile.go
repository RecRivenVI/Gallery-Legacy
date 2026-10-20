package main

import (
	"errors"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"os"
	"path/filepath"
	"runtime/pprof"
)

// CPU samples contain stacks and timings, not metadata bodies or source paths.
// The accepted config owns this directory; profiling is off by default.
func startCPUProfile(c library.Config) (func() error, error) {
	dir := filepath.Join(c.InstanceRoot, "state")
	if !c.TestOnly || !filepath.IsAbs(c.InstanceRoot) {
		return nil, errors.New("ISOLATED_INSTANCE_REQUIRED")
	}
	if e := library.NoLinks(dir); e != nil {
		return nil, e
	}
	st, e := os.Lstat(dir)
	if e != nil || !st.IsDir() || st.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		return nil, errors.New("PROFILE_DIRECTORY_UNAVAILABLE")
	}
	f, e := os.CreateTemp(dir, "scan-*.cpu")
	if e != nil {
		return nil, e
	}
	if e = pprof.StartCPUProfile(f); e != nil {
		_ = f.Close()
		return nil, e
	}
	return func() error {
		pprof.StopCPUProfile()
		return f.Close()
	}, nil
}
