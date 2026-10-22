package host

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/task"
)

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$`)

func safeFile(root string, name any) (string, error) {
	s, ok := name.(string)
	if !ok || !namePattern.MatchString(s) {
		return "", fmt.Errorf("MANAGEMENT_ID_INVALID")
	}
	p := filepath.Join(root, s)
	if err := library.NoLinks(p); err != nil {
		return "", err
	}
	return p, nil
}
func fileList(root, extension string) ([]Row, error) {
	result := []Row{}
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), extension) {
			p, err := safeFile(root, entry.Name())
			if err != nil {
				return nil, err
			}
			st, err := os.Stat(p)
			if err != nil {
				return nil, err
			}
			result = append(result, Row{"name": entry.Name(), "size": st.Size(), "mtimeMs": float64(st.ModTime().UnixNano()) / 1e6})
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i]["mtimeMs"].(float64) > result[j]["mtimeMs"].(float64) })
	return result[:min(200, len(result))], nil
}
func usage(root string) (Row, error) {
	files, bytes := int64(0), int64(0)
	err := filepath.WalkDir(root, func(p string, entry os.DirEntry, err error) error {
		if os.IsNotExist(err) && p == root {
			return filepath.SkipDir
		}
		if err != nil {
			return err
		}
		if err = library.NoLinks(p); err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			s, err := entry.Info()
			if err != nil {
				return err
			}
			files++
			bytes += s.Size()
		}
		return nil
	})
	return Row{"bytes": bytes, "files": files}, err
}
func idle(c instance.Config) error {
	owner, err := control.Owner(c, "runtime")
	if err != nil {
		return err
	}
	scan, err := task.State(c)
	if err != nil {
		return err
	}
	if owner != nil || scan["running"] == true {
		return fmt.Errorf("STOP_RUNTIME_BEFORE_CLEANUP")
	}
	return nil
}
func manageFiles(ctx context.Context, c instance.Config, o Options, op string, input Row) (output any, resultErr error) {
	switch op {
	case "config.read", "config.validate", "config.save":
		return configure(ctx, c, o, op, input)
	case "config.backups":
		items, err := fileList(filepath.Join(c.StateRoot, "config-backups"), ".json")
		return Row{"items": items}, err
	case "config.backup.read":
		file, err := safeFile(filepath.Join(c.StateRoot, "config-backups"), input["name"])
		if err != nil {
			return nil, err
		}
		var value any
		err = control.ReadJSON(file, &value)
		return Row{"value": value}, err
	case "logs.list", "reports.list":
		root, ext := c.LogsRoot, ".log"
		if op == "reports.list" {
			root, ext = c.ReportsRoot, ".json"
		}
		items, err := fileList(root, ext)
		return Row{"items": items}, err
	case "logs.read":
		return readLog(c, input)
	case "reports.read":
		file, err := safeFile(c.ReportsRoot, input["name"])
		if err != nil {
			return nil, err
		}
		var value any
		err = control.ReadJSON(file, &value)
		return Row{"value": summarize(value, 0)}, err
	case "storage.read":
		result := Row{}
		for k, root := range map[string]string{"cache": c.CacheRoot, "logs": c.LogsRoot, "temp": c.TempRoot, "generations": c.GenerationsRoot, "reports": c.ReportsRoot} {
			value, err := usage(root)
			if err != nil {
				return nil, err
			}
			result[k] = value
		}
		return result, nil
	case "logs.clear", "cache.clear":
		if input["confirm"] != true {
			return nil, fmt.Errorf("CONFIRMATION_REQUIRED")
		}
		lease, err := control.Acquire(c, "maintenance", nil)
		if err != nil {
			return nil, err
		}
		defer func() { resultErr = errors.Join(resultErr, lease.Close()) }()
		if err = idle(c); err != nil {
			return nil, err
		}
		if op == "logs.clear" {
			file, err := safeFile(c.LogsRoot, input["name"])
			if err != nil {
				return nil, err
			}
			if err = instance.Recycle(file); err != nil {
				return nil, err
			}
			return Row{"cleared": true}, os.WriteFile(file, nil, 0600)
		}
		target := filepath.Join(c.CacheRoot, "thumbnails")
		before, err := usage(target)
		if err != nil {
			return nil, err
		}
		if _, e := os.Stat(target); e == nil {
			if err = instance.Recycle(target); err != nil {
				return nil, err
			}
		}
		before["cleared"] = true
		return before, nil
	case "scope.authors":
		return authors(c, input)
	case "cache.orphans", "cache.orphans.clear":
		return cacheOperation(c, op, input)
	case "diagnostics.run":
		return diagnose(ctx, c, o.ConfigFile)
	case "generations.list", "generation.validate", "generation.publish", "generation.rollback", "live.reset", "retention.plan", "retention.apply":
		return manageRecovery(ctx, c, op, input)
	}
	return nil, fmt.Errorf("MANAGEMENT_OPERATION_INVALID")
}
func readLog(c instance.Config, input Row) (output any, resultErr error) {
	q, _ := input["query"].(string)
	level, _ := input["level"].(string)
	if len(q) > 256 || level != "" && level != "info" && level != "warn" && level != "error" {
		return nil, fmt.Errorf("LOG_FILTER_INVALID")
	}
	file, err := safeFile(c.LogsRoot, input["name"])
	if err != nil {
		return nil, err
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, f.Close()) }()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	_, err = f.Seek(max(0, st.Size()-65536), 0)
	if err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(f, 65536))
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	lines = lines[max(0, len(lines)-200):]
	result := []string{}
	for _, line := range lines {
		if input["raw"] != true {
			line = redactLog(line)
		}
		if q != "" && !strings.Contains(strings.ToLower(line), strings.ToLower(q)) {
			continue
		}
		if level != "" && !regexp.MustCompile(`(?i)"level"\s*:\s*"`+level+`"`).MatchString(line) && !(level == "error" && regexp.MustCompile(`ERROR|FAILED|INVALID`).MatchString(line)) {
			continue
		}
		result = append(result, line)
	}
	return Row{"text": strings.Join(result, "\n")}, nil
}
func authors(c instance.Config, input Row) (any, error) {
	id, _ := input["platformId"].(string)
	root := c.Sources[id]
	if root == "" {
		return nil, fmt.Errorf("INVALID_PLATFORM")
	}
	q, _ := input["query"].(string)
	page := float64(1)
	if n, ok := input["page"].(float64); ok && n != 0 {
		page = n
	}
	if page < 1 || page != float64(int64(page)) || len(q) > 256 {
		return nil, fmt.Errorf("AUTHOR_QUERY_INVALID")
	}
	if err := library.NoLinks(root); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, entry := range entries {
		if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 && strings.Contains(strings.ToLower(entry.Name()), strings.ToLower(q)) {
			names = append(names, entry.Name())
		}
	}
	items := []Row{}
	start := min(len(names), int(min(page-1, float64(len(names))))*100)
	end := min(len(names), start+100)
	for _, name := range names[start:end] {
		items = append(items, Row{"directoryName": name})
	}
	return Row{"page": page, "total": len(names), "items": items}, nil
}
func timestamp() int64 { return time.Now().UnixMilli() }
