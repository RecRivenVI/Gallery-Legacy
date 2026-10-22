package host

import (
	"context"
	"fmt"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/inspection"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/task"
)

func Connection(c instance.Config) Row {
	return Row{"url": c.URL, "instanceRoot": c.InstanceRoot, "instanceId": c.InstanceID, "desktopDataRoot": c.DesktopDataRoot, "tempRoot": c.TempRoot, "logsRoot": c.LogsRoot}
}
func Command(ctx context.Context, c instance.Config, o Options, command, operation string, input Row) (any, error) {
	switch command {
	case "connection":
		return Connection(c), nil
	case "status":
		return control.Call(ctx, c, "status", nil)
	case "start":
		fallthrough
	case "stop", "restart", "serve", "scan", "control", "manage":
		return nil, fmt.Errorf("MANAGER_REQUIRED")
	}
	return nil, fmt.Errorf("COMMAND_INVALID")
}
func Manage(ctx context.Context, c instance.Config, o Options, operation string, input Row) (any, error) {
	if err := task.Layout(c); err != nil {
		return nil, err
	}
	switch operation {
	case "scan.cancel":
		return task.Cancel(c)
	case "scan.status":
		s, err := task.State(c)
		delete(s, "identity")
		return s, err
	case "locations":
		return Row{"instance": c.InstanceRoot, "config": parent(o.ConfigFile), "logs": c.LogsRoot, "reports": c.ReportsRoot, "cache": c.CacheRoot}, nil
	}
	if strings.HasPrefix(operation, "access.") {
		return control.Call(ctx, c, operation, input)
	}
	if strings.HasPrefix(operation, "validation.") {
		return inspection.Operation(ctx, c, operation, input)
	}
	if operation == "scope.check" {
		return inspection.Scope(ctx, c, input)
	}
	return manageFiles(ctx, c, o, operation, input)
}
