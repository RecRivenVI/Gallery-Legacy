// instance prepares a new portable work database without starting a service or scan.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/task"
)

func run(file string) (err error) {
	c, err := instance.Load(file)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(filepath.Join(c.InstanceRoot, "live/catalog.sqlite")); !os.IsNotExist(err) {
		return errors.New("NEW_INSTANCE_REQUIRED")
	}
	if err = task.Layout(c); err != nil {
		return err
	}
	lease, err := control.Acquire(c, "maintenance", nil)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lease.Close()) }()
	return catalog.CreateLive(context.Background(), c.InstanceRoot, c.Sources)
}

func main() {
	file := flag.String("config", "", "explicit new instance configuration")
	flag.Parse()
	if err := run(*file); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
