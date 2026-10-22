package instance

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func PhysicalPath(target string) (string, error) {
	current, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	suffix := []string{}
	for {
		_, err = os.Stat(current)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return filepath.Clean(target), nil
		}
		suffix = append([]string{filepath.Base(current)}, suffix...)
		current = parent
	}
	current, err = filepath.EvalSymlinks(current)
	if err != nil {
		return "", err
	}
	return filepath.Join(append([]string{current}, suffix...)...), nil
}
func overlap(a, b string) bool { return library.Inside(a, b) || library.Inside(b, a) }
func bindSources(config *Config, value any) error {
	values, ok := value.(map[string]any)
	def, err := api.LoadCatalog()
	if err != nil {
		return err
	}
	if !ok || len(values) != len(def.Platforms) {
		return fmt.Errorf("Exactly nine source bindings are required")
	}
	config.Sources = map[string]string{}
	config.Platforms = []Platform{}
	config.ProtectedRoots = []map[string]any{}
	for _, p := range def.Platforms {
		root, ok := values[p.ID].(string)
		if !ok || !filepath.IsAbs(root) {
			return fmt.Errorf("Source roots must be absolute paths")
		}
		if err = library.NoLinks(root); err != nil {
			return err
		}
		root, err = PhysicalPath(root)
		if err != nil {
			return err
		}
		if overlap(config.InstanceRoot, root) {
			return fmt.Errorf("INSTANCE_SOURCE_OVERLAP")
		}
		for _, other := range config.Platforms {
			if rootKey(root) == rootKey(other.PhysicalRoot) {
				return fmt.Errorf("Duplicate physical source root")
			}
			if overlap(other.PhysicalRoot, root) {
				return fmt.Errorf("SOURCE_ROOT_OVERLAP")
			}
		}
		config.Sources[p.ID] = root
		config.Platforms = append(config.Platforms, Platform{p.ID, p.Family, p.Enabled, p.AdapterVersion, root})
		config.ProtectedRoots = append(config.ProtectedRoots, map[string]any{"id": p.ID, "family": p.Family, "enabled": p.Enabled, "adapterVersion": p.AdapterVersion, "physicalRoot": root})
	}
	return nil
}

func rootKey(value string) string {
	return strings.ToLower(strings.TrimRight(filepath.Clean(value), `/\`))
}

func configurePaths(config *Config, source map[string]any) error {
	paths := []struct {
		key, directory string
		out            *string
	}{
		{"generationsRoot", "generations", &config.GenerationsRoot}, {"cacheRoot", "cache", &config.CacheRoot}, {"logsRoot", "logs", &config.LogsRoot}, {"tempRoot", "temp", &config.TempRoot}, {"stateRoot", "state", &config.StateRoot}, {"reportsRoot", "reports", &config.ReportsRoot}, {"desktopDataRoot", "desktop-data", &config.DesktopDataRoot},
	}
	for _, p := range paths {
		value := stringOr(source[p.key], filepath.Join(config.InstanceRoot, p.directory))
		if !filepath.IsAbs(value) || !library.Inside(config.InstanceRoot, value) || filepath.Clean(value) == config.InstanceRoot {
			return fmt.Errorf("RUNTIME_PATH_ESCAPE")
		}
		if err := library.NoLinks(value); err != nil {
			return err
		}
		*p.out = filepath.Clean(value)
	}
	writable := paths[1:]
	for _, p := range writable {
		if overlap(*p.out, config.GenerationsRoot) {
			return fmt.Errorf("GENERATION_WRITE_OVERLAP")
		}
	}
	if config.LiveUpdates {
		live := filepath.Join(config.InstanceRoot, "live")
		if err := library.NoLinks(live); err != nil {
			return err
		}
		for _, p := range paths {
			if overlap(*p.out, live) {
				return fmt.Errorf("LIVE_PATH_OVERLAP")
			}
		}
	}
	for i, p := range writable {
		for _, other := range writable[i+1:] {
			if overlap(*p.out, *other.out) {
				return fmt.Errorf("RUNTIME_PATH_OVERLAP")
			}
		}
	}
	config.ActiveGenerationPath = filepath.Join(config.InstanceRoot, "active-generation.json")
	config.StatusPath = filepath.Join(config.StateRoot, "runtime.json")
	config.ScanStatusPath = filepath.Join(config.StateRoot, "scan.json")
	return nil
}
