package host

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/recovery"
	"github.com/google/uuid"
)

var generationID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func manageRecovery(ctx context.Context, c instance.Config, op string, input Row) (output any, resultErr error) {
	if op == "generations.list" {
		var active, status Row
		_ = control.ReadJSON(c.ActiveGenerationPath, &active)
		_ = control.ReadJSON(c.StatusPath, &status)
		items := []Row{}
		entries, err := os.ReadDir(c.GenerationsRoot)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if !entry.IsDir() || !generationID.MatchString(entry.Name()) {
				continue
			}
			var m Row
			manifest := filepath.Join(c.GenerationsRoot, entry.Name(), "manifest.json")
			if err := library.NoLinks(manifest); err != nil {
				return nil, err
			}
			if err := control.ReadJSON(manifest, &m); err != nil {
				return nil, err
			}
			catalog, _ := m["catalog"].(map[string]any)
			search, _ := m["search"].(map[string]any)
			items = append(items, Row{"id": entry.Name(), "state": m["state"], "createdAtMs": m["createdAtMs"], "works": catalog["workCount"], "bytes": number(catalog["sizeBytes"]) + number(search["sizeBytes"])})
		}
		result := Row{"items": items}
		if active["generationId"] != nil {
			result["active"] = active["generationId"]
		}
		if status["loadedGenerationId"] != nil {
			result["loaded"] = status["loadedGenerationId"]
		}
		return result, nil
	}
	lease, err := control.Acquire(c, "maintenance", nil)
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, lease.Close()) }()
	if op == "live.reset" {
		if input["confirm"] != true {
			return nil, fmt.Errorf("CONFIRMATION_REQUIRED")
		}
		if err = idle(c); err != nil {
			return nil, err
		}
		g, err := recovery.Active(ctx, c.InstanceRoot, c.GenerationsRoot, c.ActiveGenerationPath)
		if err != nil {
			return nil, err
		}
		archive := "live-reset-" + uuid.NewString()
		target := filepath.Join(c.InstanceRoot, "live")
		if err = library.NoLinks(target); err != nil {
			return nil, err
		}
		for _, p := range []string{c.GenerationsRoot, c.CacheRoot, c.LogsRoot, c.StateRoot, c.TempRoot, c.DesktopDataRoot} {
			if library.Inside(p, target) || library.Inside(target, p) {
				return nil, fmt.Errorf("LIVE_PATH_OVERLAP")
			}
		}
		if _, e := os.Stat(target); e == nil {
			if err = os.Rename(target, filepath.Join(c.TempRoot, archive)); err != nil {
				return nil, err
			}
		}
		return Row{"reset": true, "checkpoint": g.GenerationID, "archive": archive, "restartRequired": true}, nil
	}
	if op == "retention.plan" || op == "retention.apply" {
		return retention(c, op, input)
	}
	id, _ := input["id"].(string)
	if !namePattern.MatchString(id) {
		return nil, fmt.Errorf("MANAGEMENT_ID_INVALID")
	}
	g, err := recovery.Open(ctx, c.InstanceRoot, c.GenerationsRoot, id)
	if err != nil {
		return nil, err
	}
	if op != "generation.validate" {
		if input["confirm"] != true {
			return nil, fmt.Errorf("CONFIRMATION_REQUIRED")
		}
		if err = publish(c, id); err != nil {
			return nil, err
		}
	}
	return Row{"valid": true, "generationId": id, "works": g.Facts["works"], "published": op != "generation.validate", "restartRequired": op != "generation.validate"}, nil
}
func number(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	}
	return 0
}
func publish(c instance.Config, id string) error {
	return recovery.Publish(c, id)
}
func retention(c instance.Config, op string, input Row) (any, error) {
	if op == "retention.apply" && input["confirm"] != true {
		return nil, fmt.Errorf("CONFIRMATION_REQUIRED")
	}
	// Publication/ownership protection is resolved before any removal. Unknown
	// manifests stay retained; source paths are never accepted as cleanup targets.
	var pointer, status, scan Row
	_ = control.ReadJSON(c.ActiveGenerationPath, &pointer)
	_ = control.ReadJSON(c.StatusPath, &status)
	_ = control.ReadJSON(c.ScanStatusPath, &scan)
	protected := map[any]bool{pointer["generationId"]: true, pointer["previousGenerationId"]: true}
	uncertain := pointer["generationId"] == nil
	for _, pair := range []struct {
		scope string
		value Row
	}{{"runtime", status}, {"scan", scan}} {
		owner, e := control.Owner(c, pair.scope)
		if e != nil {
			uncertain = true
		}
		if owner != nil {
			key := "loadedGenerationId"
			if pair.scope == "scan" {
				key = "generationId"
			}
			protected[pair.value[key]] = true
			if pair.value[key] == nil {
				uncertain = true
			}
		}
	}
	entries, err := os.ReadDir(c.GenerationsRoot)
	if err != nil {
		return nil, err
	}
	items := []Row{}
	var latest string
	var latestTime int64
	for _, entry := range entries {
		var m Row
		if entry.IsDir() && generationID.MatchString(entry.Name()) {
			manifest := filepath.Join(c.GenerationsRoot, entry.Name(), "manifest.json")
			if library.NoLinks(manifest) == nil {
				_ = control.ReadJSON(manifest, &m)
			}
		}
		state, _ := m["state"].(string)
		if m["generationId"] != entry.Name() || !slices.Contains([]string{"BUILDING", "VALIDATED", "READY", "FAILED"}, state) {
			items = append(items, Row{"id": entry.Name(), "action": "RETAIN", "reason": "unknown", "state": "UNKNOWN"})
			continue
		}
		at := m["readyAtMs"]
		if at == nil || number(at) == 0 {
			at = m["createdAtMs"]
		}
		if m["state"] == "READY" && entry.Name() != pointer["generationId"] && (latest == "" || number(at) > latestTime) {
			latest = entry.Name()
			latestTime = number(at)
		}
		item := Row{"id": entry.Name(), "state": m["state"], "pinned": m["pinned"] == true}
		if at != nil {
			item["createdAtMs"] = at
		}
		items = append(items, item)
	}
	protected[latest] = true
	removed := []Row{}
	bytes := int64(0)
	for _, item := range items {
		if item["action"] != nil {
			continue
		}
		item["action"] = "RETAIN"
		item["reason"] = "referenced_or_previous"
		if uncertain {
			item["reason"] = "ownership_uncertain"
			continue
		}
		if protected[item["id"]] || item["pinned"] == true || !c.Retention.Enabled {
			continue
		}
		_, validTime := item["createdAtMs"].(float64)
		if !validTime || timestamp()-number(item["createdAtMs"]) < c.Retention.StaleAfterMS {
			item["reason"] = "recent"
			continue
		}
		item["action"] = "DELETE"
		item["reason"] = "abandoned_unreferenced"
		if item["state"] == "READY" {
			item["reason"] = "superseded_unreferenced"
		}
		if op == "retention.apply" {
			target := filepath.Join(c.GenerationsRoot, item["id"].(string))
			u, e := usage(target)
			if e != nil {
				return nil, e
			}
			if e = exclusiveDatabases(target); e != nil {
				item["action"], item["reason"] = "RETAIN", "file_in_use_or_unverifiable"
				continue
			}
			retired := filepath.Join(c.TempRoot, "retired-generation-"+uuid.NewString())
			if e = os.Rename(target, retired); e != nil {
				if os.IsPermission(e) {
					item["action"], item["reason"] = "RETAIN", "file_in_use"
					continue
				}
				return nil, e
			}
			if e = instance.Recycle(retired); e != nil {
				if restore := os.Rename(retired, target); restore != nil {
					return nil, fmt.Errorf("restore retired generation: %w", restore)
				}
				return nil, e
			}
			bytes += number(u["bytes"])
			removed = append(removed, Row{"id": item["id"], "state": item["state"], "bytes": number(u["bytes"]), "reason": item["reason"]})
		}
	}
	if op == "retention.plan" {
		return Row{"items": items}, nil
	}
	report := Row{"atMs": timestamp(), "plan": items, "removed": removed, "bytes": bytes}
	return report, instance.WriteJSON(filepath.Join(c.ReportsRoot, "retention.json"), report)
}
