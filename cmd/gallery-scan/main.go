package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/indexing"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

var version = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print build version")
	file := flag.String("config", "", "isolated scan configuration")
	platforms := flag.String("platforms", "", "comma-separated fixed platforms")
	mode := flag.String("mode", "full", "full or incremental scan")
	author := flag.String("author", "", "one physical author directory in one platform")
	delay := flag.Int("synthetic-delay-ms", 0, "synthetic test delay only")
	profile := flag.Bool("cpu-profile", false, "record CPU samples in the isolated instance state directory")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	c, e := library.Load(*file)
	if e != nil {
		fmt.Fprintln(os.Stderr, "CONFIG_REJECTED")
		os.Exit(2)
	}
	if *delay > 0 {
		for _, root := range c.Sources {
			if !library.Inside(filepath.Join(filepath.Dir(c.InstanceRoot), "sources"), root) {
				fmt.Fprintln(os.Stderr, "SYNTHETIC_ONLY")
				os.Exit(2)
			}
		}
	}
	debug.SetMemoryLimit(256 << 20)
	var stopProfile func() error
	if *profile {
		stopProfile, e = startCPUProfile(c)
		if e != nil {
			fmt.Fprintln(os.Stderr, "PROFILE_START_FAILED")
			os.Exit(2)
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	go func() {
		defer cancel()
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			if scanner.Text() == "cancel" {
				cancel()
				return
			}
		}
	}()
	ids := catalog.SortedPlatforms()
	if *platforms != "" {
		ids = strings.Split(*platforms, ",")
	}
	mu := sync.Mutex{}
	p := indexing.Pipeline{Config: c, Mode: *mode, AuthorDirectoryName: *author, Delay: time.Duration(*delay) * time.Millisecond, Emit: func(s indexing.Status) { mu.Lock(); defer mu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(s) }}
	e = p.Run(ctx, ids)
	if stopProfile != nil {
		if profileError := stopProfile(); profileError != nil {
			fmt.Fprintln(os.Stderr, "PROFILE_NOT_COMPLETE")
			if e == nil {
				os.Exit(1)
			}
		}
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, "SCAN_NOT_COMPLETE")
		os.Exit(1)
	}
}
