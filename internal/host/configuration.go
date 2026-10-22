package host

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/google/uuid"
)

func parent(p string) string { return filepath.Dir(p) }
func configView(file string) (Row, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var value any
	if err = json.Unmarshal(b, &value); err != nil {
		return nil, err
	}
	h := sha256.Sum256(b)
	contract, err := api.LoadCatalog()
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, p := range contract.Platforms {
		ids = append(ids, p.ID)
	}
	return Row{"value": value, "revision": hex.EncodeToString(h[:]), "platforms": ids}, nil
}
func configure(ctx context.Context, c instance.Config, o Options, op string, input Row) (output any, resultErr error) {
	if op == "config.read" {
		return configView(o.ConfigFile)
	}
	value, ok := input["value"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("CONFIG_INVALID")
	}
	b, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	next, err := instance.Parse(b)
	if err != nil {
		return nil, err
	}
	for _, pair := range [][2]string{{c.InstanceRoot, next.InstanceRoot}, {c.GenerationsRoot, next.GenerationsRoot}, {c.StateRoot, next.StateRoot}, {c.CacheRoot, next.CacheRoot}, {c.TempRoot, next.TempRoot}, {c.ReportsRoot, next.ReportsRoot}, {c.LogsRoot, next.LogsRoot}, {c.DesktopDataRoot, next.DesktopDataRoot}} {
		if pair[0] != pair[1] {
			return nil, fmt.Errorf("INSTANCE_LAYOUT_CHANGE_REQUIRES_NEW_INSTANCE")
		}
	}
	changed := !reflect.DeepEqual(c.Sources, next.Sources)
	result := Row{"valid": true, "restartRequired": true, "rebuildRequired": changed}
	if c.LiveUpdates && next.LiveUpdates && changed {
		return nil, fmt.Errorf("LIVE_SOURCE_CHANGE_REQUIRES_CHECKPOINT")
	}
	if op == "config.validate" {
		return result, nil
	}
	if input["confirm"] != true {
		return nil, fmt.Errorf("CONFIRMATION_REQUIRED")
	}
	if !library.Inside(c.InstanceRoot, o.ConfigFile) {
		return nil, fmt.Errorf("CONFIG_EDIT_OUTSIDE_INSTANCE")
	}
	lease, err := control.Acquire(c, "maintenance", nil)
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, lease.Close()) }()
	view, err := configView(o.ConfigFile)
	if err != nil {
		return nil, err
	}
	if input["revision"] != view["revision"] {
		return nil, fmt.Errorf("CONFIG_REVISION_CHANGED")
	}
	backup := fmt.Sprintf("%d-%s.json", time.Now().UnixMilli(), uuid.NewString())
	if err = instance.WriteJSON(filepath.Join(c.StateRoot, "config-backups", backup), view["value"]); err != nil {
		return nil, err
	}
	if err = instance.WriteJSON(o.ConfigFile, value); err != nil {
		return nil, err
	}
	view, err = configView(o.ConfigFile)
	if err != nil {
		return nil, err
	}
	for k, v := range view {
		result[k] = v
	}
	result["backup"] = backup
	return result, nil
}
