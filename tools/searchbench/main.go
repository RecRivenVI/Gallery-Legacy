// searchbench builds a synthetic catalog-scale query corpus, not a filesystem
// scan fixture. No real roots, source enumeration or media reads participate.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	root := flag.String("root", "", "external synthetic query corpus")
	output := flag.String("output", "", "external measurement JSON")
	create := flag.Bool("create", false, "create a new corpus before measuring")
	flag.Parse()
	if err := run(context.Background(), *root, *output, *create); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, root, output string, create bool) error {
	if !filepath.IsAbs(root) || !filepath.IsAbs(output) {
		return fmt.Errorf("absolute external root/output required")
	}
	if create {
		if err := seed(ctx, root); err != nil {
			return err
		}
	}
	raw, err := os.ReadFile(filepath.Join(root, ".gallery-query-corpus.json"))
	if err != nil {
		return err
	}
	var marker struct {
		Kind  string
		Works int64
	}
	if err = json.Unmarshal(raw, &marker); err != nil {
		return err
	}
	if marker.Kind != "gallery-query-corpus" || marker.Works != 390000 {
		return fmt.Errorf("synthetic query corpus required")
	}
	result, err := measure(ctx, filepath.Join(root, "instance/live/catalog.sqlite"))
	if err != nil {
		return err
	}
	raw, err = json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(output), 0700); err != nil {
		return err
	}
	if err = os.WriteFile(output, append(raw, '\n'), 0600); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
