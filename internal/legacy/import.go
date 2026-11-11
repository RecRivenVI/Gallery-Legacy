package legacy

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type Summary struct {
	Reports, FailedReports, Archives, Clients, Events int
}

type archive struct {
	path string
	body []byte
}

var reportName = regexp.MustCompile(`^scan-[0-9]{17}-[0-9a-f]{6}\.json$`)
var scopeName = regexp.MustCompile(`^manager-scope-[0-9]+\.json$`)

func Import(source string, target instance.Config) (summary Summary, result error) {
	source = filepath.Clean(source)
	if !filepath.IsAbs(source) || library.Inside(source, target.InstanceRoot) || library.Inside(target.InstanceRoot, source) {
		return summary, errors.New("LEGACY_IMPORT_TARGET_OVERLAP")
	}
	for _, path := range []string{source, filepath.Join(source, "reports"), filepath.Join(source, "logs"), filepath.Join(source, "state"), target.ReportsRoot, target.StateRoot} {
		if err := library.NoLinks(path); err != nil {
			return summary, err
		}
	}
	lease, err := control.Acquire(target, "maintenance", nil)
	if err != nil {
		return summary, err
	}
	defer func() { result = errors.Join(result, lease.Close()) }()
	for _, owner := range []string{"manager", "runtime", "scan"} {
		record, err := control.Owner(target, owner)
		if err != nil {
			return summary, err
		}
		if record != nil {
			return summary, errors.New("LEGACY_IMPORT_TARGET_ACTIVE")
		}
	}
	reports, archives, failed, err := captureReports(source)
	if err != nil {
		return summary, err
	}
	old, err := consistentFile(filepath.Join(source, "state", "access-history.json"))
	if err != nil {
		return summary, fmt.Errorf("read legacy access snapshot: %w", err)
	}
	original, err := parseHistory(old, "")
	if err != nil {
		return summary, err
	}
	targetFile := filepath.Join(target.StateRoot, "access-history.json")
	b, err := instance.ReadSnapshot(targetFile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return summary, err
	}
	current, err := parseHistory(b, target.InstanceID)
	if err != nil {
		return summary, err
	}
	merged, err := mergeHistory(original, current, time.Now())
	if err != nil {
		return summary, err
	}
	archives = append(archives, archive{filepath.Join("state", digestName("access-history.json", old)), old})

	archiveRoot := filepath.Join(target.ReportsRoot, "legacy-originals")
	for _, item := range archives {
		if err = preserve(filepath.Join(archiveRoot, item.path), item.body); err != nil {
			return summary, err
		}
	}
	for file, report := range reports {
		if err = preserve(filepath.Join(target.ReportsRoot, file), report); err != nil {
			return summary, err
		}
	}
	if err = instance.WriteJSON(targetFile, merged); err != nil {
		return summary, err
	}
	return Summary{len(reports), failed, len(archives), len(merged.Clients), len(merged.Events)}, nil
}

func captureReports(source string) (map[string][]byte, []archive, int, error) {
	reports := map[string][]byte{}
	var archives []archive
	failed := 0
	files, err := os.ReadDir(filepath.Join(source, "reports"))
	if err != nil {
		return nil, nil, 0, err
	}
	for _, f := range files {
		name := f.Name()
		if !f.Type().IsRegular() || !reportName.MatchString(name) && !scopeName.MatchString(name) && !oneTimeReport(name) {
			continue
		}
		b, err := consistentFile(filepath.Join(source, "reports", name))
		if err != nil {
			return nil, nil, 0, fmt.Errorf("read legacy report: %w", err)
		}
		var original row
		if err = json.Unmarshal(b, &original); err != nil || original == nil {
			return nil, nil, 0, errors.Join(errors.New("LEGACY_REPORT_INVALID"), err)
		}
		archives = append(archives, archive{filepath.Join("reports", name), b})
		if !reportName.MatchString(name) {
			continue
		}
		report, err := convertReport(name, original)
		if err != nil {
			return nil, nil, 0, err
		}
		if report["state"] == "FAILED" {
			failed++
		}
		raw, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			return nil, nil, 0, err
		}
		reports["legacy-"+name] = append(raw, '\n')
	}
	for _, name := range []string{"runtime-start.log", "scan-launch.log"} {
		b, err := consistentFile(filepath.Join(source, "logs", name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, nil, 0, fmt.Errorf("read legacy log: %w", err)
		}
		archives = append(archives, archive{filepath.Join("logs", digestName(name, b)), b})
	}
	return reports, archives, failed, nil
}

func oneTimeReport(name string) bool {
	switch name {
	case "acceptance.json", "deployment-before.json", "deployment-verification.json", "production-firewall.json", "retention.json", "runtime-safety.json":
		return true
	}
	return false
}

func convertReport(name string, original row) (row, error) {
	id := strings.TrimSuffix(name, ".json")
	if original["generationId"] != id && original["generationId"] != strings.TrimPrefix(id, "scan-") {
		return nil, errors.New("LEGACY_REPORT_IDENTITY_INVALID")
	}
	state, _ := original["state"].(string)
	if state != "READY" && state != "FAILED" && state != "CANCELLED" {
		return nil, errors.New("LEGACY_REPORT_STATE_INVALID")
	}
	report := row{"state": state, "generationId": id, "scanner": "legacy", "legacy": true, "original": "legacy-originals/reports/" + name}
	for _, key := range []string{"mode", "effectiveMode", "elapsedMs", "changes", "scope", "failure", "searchRebuilt"} {
		if value, ok := original[key]; ok {
			report[key] = value
		}
	}
	if catalog, ok := original["catalog"].(map[string]any); ok {
		counts := row{}
		for _, key := range []string{"workCount", "mediaCount", "authorCount"} {
			if count, ok := catalog[key].(float64); ok {
				counts[key] = count
			}
		}
		report["catalog"] = counts
	}
	return report, nil
}

func consistentFile(path string) ([]byte, error) {
	if err := library.NoLinks(path); err != nil {
		return nil, err
	}
	before, err := instance.ReadSnapshot(path)
	if err != nil {
		return nil, err
	}
	for range 2 {
		after, err := instance.ReadSnapshot(path)
		if err != nil {
			return nil, err
		}
		if bytes.Equal(before, after) {
			return after, nil
		}
		before = after
	}
	return nil, errors.New("LEGACY_SOURCE_CHANGED_DURING_COPY")
}

func digestName(name string, data []byte) string {
	digest := sha256.Sum256(data)
	ext := filepath.Ext(name)
	return strings.TrimSuffix(name, ext) + "-" + hex.EncodeToString(digest[:8]) + ext
}

func preserve(path string, data []byte) error {
	if err := library.NoLinks(path); err != nil {
		return err
	}
	if b, err := os.ReadFile(path); err == nil {
		if !bytes.Equal(b, data) {
			return errors.New("LEGACY_IMPORT_ARCHIVE_COLLISION")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "legacy-copy-*.tmp")
	if err != nil {
		return err
	}
	defer instance.RemoveOwned(f.Name())
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if err = errors.Join(err, f.Close()); err != nil {
		return err
	}
	return os.Link(f.Name(), path)
}
