// legacy imports records into an explicitly selected, stopped instance.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/legacy"
)

func main() {
	source := flag.String("legacy-root", "", "absolute read-only legacy instance root")
	config := flag.String("config", "", "absolute target instance configuration")
	flag.Parse()
	if *source == "" || *config == "" {
		fmt.Fprintln(os.Stderr, "LEGACY_IMPORT_EXPLICIT_PATHS_REQUIRED")
		os.Exit(1)
	}
	target, err := instance.Load(*config)
	if err == nil {
		var summary legacy.Summary
		summary, err = legacy.Import(*source, target)
		if err == nil {
			err = json.NewEncoder(os.Stdout).Encode(summary)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
