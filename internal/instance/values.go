package instance

import (
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

var fileRootID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,40}$`)
var shortCode = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0 && !math.IsNaN(v)
	default:
		return true
	}
}
func stringOr(value any, fallback string) string {
	if !truthy(value) {
		return fallback
	}
	text, _ := value.(string)
	return text
}
func defaults() (map[string]map[string]any, error) {
	var schema struct{ Properties map[string]map[string]any }
	err := json.Unmarshal(api.ConfigurationSchema, &schema)
	return schema.Properties, err
}

func bindFileRoots(config *Config, value any) error {
	config.FileBrowserRoots = []FileRoot{}
	if value == nil {
		return nil
	}
	entries, ok := value.([]any)
	if !ok {
		return fmt.Errorf("FILE_ROOT_INVALID")
	}
	for _, value := range entries {
		entry, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("FILE_ROOT_INVALID")
		}
		id, _ := entry["id"].(string)
		root, _ := entry["path"].(string)
		if !fileRootID.MatchString(id) || !filepath.IsAbs(root) {
			return fmt.Errorf("FILE_ROOT_INVALID")
		}
		if err := library.NoLinks(root); err != nil {
			return err
		}
		root, err := PhysicalPath(root)
		if err != nil {
			return err
		}
		if overlap(config.InstanceRoot, root) {
			return fmt.Errorf("INSTANCE_SOURCE_OVERLAP")
		}
		for _, platform := range config.Platforms {
			if library.Inside(platform.PhysicalRoot, root) {
				return fmt.Errorf("FILE_ROOT_INSIDE_PLATFORM")
			}
		}
		for _, other := range config.FileBrowserRoots {
			if id == other.ID || overlap(root, other.PhysicalRoot) {
				return fmt.Errorf("FILE_ROOT_OVERLAP")
			}
		}
		name := stringOr(entry["name"], "文件浏览")
		config.FileBrowserRoots = append(config.FileBrowserRoots, FileRoot{id, name, root, root})
		config.ProtectedRoots = append(config.ProtectedRoots, map[string]any{"id": id, "name": name, "path": root, "physicalRoot": root})
	}
	return nil
}

func configureValues(config *Config, source map[string]any) error {
	properties, err := defaults()
	if err != nil {
		return err
	}
	config.Deployment = stringOr(source["deployment"], properties["deployment"]["default"].(string))
	if config.Deployment != "development" && config.Deployment != "staging" && config.Deployment != "production" {
		return fmt.Errorf("DEPLOYMENT_INVALID")
	}
	config.ShortLinks = map[string]string{}
	if value := source["shortLinks"]; truthy(value) {
		links, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("SHORT_LINKS_INVALID")
		}
		for key, value := range links {
			target, ok := value.(string)
			if !ok || !shortCode.MatchString(key) || !strings.HasPrefix(target, "/") || strings.HasPrefix(target, "//") || strings.HasPrefix(target, "/\\") || hasControl(target) {
				return fmt.Errorf("SHORT_LINK_INVALID")
			}
			config.ShortLinks[key] = target
		}
	}
	retention, _ := source["retention"].(map[string]any)
	definitions := properties["retention"]["properties"].(map[string]any)
	config.Retention.Enabled = retention["enabled"] != false
	value := retention["staleAfterMs"]
	if value == nil {
		value = definitions["staleAfterMs"].(map[string]any)["default"]
	}
	n, ok := value.(float64)
	if !ok || n < 3600000 || math.Trunc(n) != n || n > 9007199254740991 {
		return fmt.Errorf("RETENTION_INVALID")
	}
	config.Retention.StaleAfterMS = int64(n)
	return nil
}
func hasControl(value string) bool {
	for len(value) > 0 {
		r, n := utf8.DecodeRuneInString(value)
		if r <= 31 || r == 127 {
			return true
		}
		value = value[n:]
	}
	return false
}
