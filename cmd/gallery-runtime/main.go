package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/host"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

var version = "dev"

func run() error {
	args := os.Args[1:]
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println(version)
		return nil
	}
	if len(args) == 0 {
		return fmt.Errorf("MANAGER_REQUIRED")
	}
	command := args[0]
	if command != "manager" && command != "connection" && command != "status" {
		return fmt.Errorf("MANAGER_REQUIRED")
	}
	var manager *control.Identity
	var err error
	if command == "manager" {
		manager, err = host.ManagerIdentity()
		if err != nil {
			return err
		}
	}
	flags := map[string]string{}
	for i := 1; i < len(args); i += 2 {
		if i+1 == len(args) {
			return fmt.Errorf("COMMAND_ARGUMENT_MISSING")
		}
		flags[args[i]] = args[i+1]
	}
	file := flags["--config"]
	if file == "" {
		return fmt.Errorf("CONFIG_REQUIRED")
	}
	c, err := instance.Load(file)
	if err != nil {
		return err
	}
	o := host.Options{ConfigFile: file, Frontend: flags["--frontend"], Assets: flags["--assets"]}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if command == "manager" {
		return host.RunSession(ctx, c, o, manager, os.Stdin, os.Stdout)
	}
	result, err := host.Command(ctx, c, o, command, "", nil)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, control.Code(err, "FAILED"))
		os.Exit(1)
	}
}
