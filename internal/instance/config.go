// Package instance owns runtime configuration and instance paths.
package instance

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type Platform struct {
	ID             string `json:"id"`
	Family         string `json:"family"`
	Enabled        bool   `json:"enabled"`
	AdapterVersion int    `json:"adapterVersion"`
	PhysicalRoot   string `json:"physicalRoot"`
}
type FileRoot struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Path         string `json:"path"`
	PhysicalRoot string `json:"physicalRoot"`
}
type Retention struct {
	Enabled      bool  `json:"enabled"`
	StaleAfterMS int64 `json:"staleAfterMs"`
}
type Config struct {
	Deployment           string            `json:"deployment"`
	InstanceRoot         string            `json:"instanceRoot"`
	InstanceID           string            `json:"instanceId"`
	LiveUpdates          bool              `json:"liveUpdates"`
	Sources              map[string]string `json:"sources"`
	Platforms            []Platform        `json:"platforms"`
	FileBrowserRoots     []FileRoot        `json:"fileBrowserRoots"`
	ProtectedRoots       []map[string]any  `json:"protectedRoots"`
	Host                 string            `json:"host"`
	Port                 int               `json:"port"`
	Mode                 string            `json:"mode"`
	AllowedHosts         []string          `json:"allowedHosts"`
	AllowedOrigins       []string          `json:"allowedOrigins"`
	LocalHosts           []string          `json:"localHosts"`
	PublicURL            string            `json:"publicUrl"`
	ShortLinks           map[string]string `json:"shortLinks"`
	Retention            Retention         `json:"retention"`
	GenerationsRoot      string            `json:"generationsRoot"`
	CacheRoot            string            `json:"cacheRoot"`
	LogsRoot             string            `json:"logsRoot"`
	TempRoot             string            `json:"tempRoot"`
	StateRoot            string            `json:"stateRoot"`
	ReportsRoot          string            `json:"reportsRoot"`
	DesktopDataRoot      string            `json:"desktopDataRoot"`
	ActiveGenerationPath string            `json:"activeGenerationPath"`
	StatusPath           string            `json:"statusPath"`
	ScanStatusPath       string            `json:"scanStatusPath"`
	URL                  string            `json:"url"`
}

func Load(file string) (Config, error) {
	var zero Config
	bytes, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return zero, fmt.Errorf("CONFIG_REQUIRED")
	}
	if err != nil {
		return zero, err
	}
	return Parse(bytes)
}

// Parse validates the same document used on disk without persisting a candidate.
func Parse(bytes []byte) (Config, error) {
	var zero Config
	var value any
	if err := json.Unmarshal(bytes, &value); err != nil {
		return zero, fmt.Errorf("STATE_INVALID: %w", err)
	}
	if !truthy(value) {
		return zero, fmt.Errorf("CONFIG_REQUIRED")
	}
	source, ok := value.(map[string]any)
	if !ok {
		switch v := value.(type) {
		case string:
			if v != "" {
				return zero, fmt.Errorf("CONFIG_FIELD_UNSUPPORTED")
			}
		case []any:
			if len(v) > 0 {
				return zero, fmt.Errorf("CONFIG_FIELD_UNSUPPORTED")
			}
		}
		return Normalize(nil)
	}
	var schema struct{ Properties map[string]any }
	if err := json.Unmarshal(api.ConfigurationSchema, &schema); err != nil {
		return zero, err
	}
	for key := range source {
		if _, ok := schema.Properties[key]; !ok {
			return zero, fmt.Errorf("CONFIG_FIELD_UNSUPPORTED")
		}
	}
	return Normalize(source)
}

func Normalize(source map[string]any) (Config, error) {
	var config Config
	root, ok := source["instanceRoot"].(string)
	if !ok || !filepath.IsAbs(root) {
		return config, fmt.Errorf("INSTANCE_PATH_REQUIRED")
	}
	for _, key := range []string{"catalogPath", "catalog", "searchIndexPath", "searchIndex", "rules", "physicalRoot", "allowOldCatalog"} {
		if _, ok := source[key]; ok {
			return config, fmt.Errorf("DIRECT_DATABASE_CONFIG_FORBIDDEN")
		}
	}
	// Everything was explicitly retired. Do not silently accept an active legacy
	// endpoint while running the filesystem-only backend.
	if source["everything"] != nil {
		return config, fmt.Errorf("CONFIG_FIELD_UNSUPPORTED")
	}
	if err := library.NoLinks(root); err != nil {
		return config, err
	}
	root, err := PhysicalPath(root)
	if err != nil {
		return config, err
	}
	config.InstanceRoot = root
	if value, exists := source["liveUpdates"]; exists {
		config.LiveUpdates, ok = value.(bool)
		if !ok {
			return config, fmt.Errorf("LIVE_UPDATES_INVALID")
		}
	}
	if err = bindSources(&config, source["sources"]); err != nil {
		return config, err
	}
	if value, exists := source["fileBrowserRoots"]; exists && value == nil {
		return config, fmt.Errorf("FILE_ROOT_INVALID")
	}
	if err = bindFileRoots(&config, source["fileBrowserRoots"]); err != nil {
		return config, err
	}
	if err = configureNetwork(&config, source); err != nil {
		return config, err
	}
	if err = configureValues(&config, source); err != nil {
		return config, err
	}
	if err = configurePaths(&config, source); err != nil {
		return config, err
	}
	hash := sha256.Sum256([]byte(strings.ToLower(root)))
	config.InstanceID = hex.EncodeToString(hash[:])
	return config, nil
}
