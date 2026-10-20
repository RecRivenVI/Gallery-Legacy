package library

import (
	"encoding/json"
	"errors"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	InstanceRoot      string            `json:"instanceRoot"`
	Database          string            `json:"database"`
	ListingSource     string            `json:"listingSource"`
	Sources           map[string]string `json:"sources"`
	TestOnly          bool              `json:"testOnly"`
	Workers           int               `json:"workers"`
	SlowDeviceWorkers int               `json:"slowDeviceWorkers,omitempty"`
	BatchSize         int               `json:"batchSize"`
	MetadataLimit     int64             `json:"metadataLimit"`
}

func Inside(root, target string) bool {
	r, e := filepath.Rel(strings.ToLower(filepath.Clean(root)), strings.ToLower(filepath.Clean(target)))
	return e == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) && !filepath.IsAbs(r)
}

// Inspect the directory once, then check its ancestors. Neither the leaf check
// nor the parent chain is cached: a later source replacement must be detected.
func ObserveDirectory(path string) (os.FileInfo, error) {
	st, e := observeDirectoryLeaf(path)
	if e != nil {
		return nil, e
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("PATH_REPARSE")
	}
	if !st.IsDir() {
		return nil, errors.New("NOT_DIRECTORY")
	}
	if e = NoLinks(filepath.Dir(path)); e != nil {
		return nil, e
	}
	return st, nil
}
func Load(file string) (Config, error) {
	var c Config
	b, e := os.ReadFile(file)
	if e != nil {
		return c, e
	}
	if e = json.Unmarshal(b, &c); e != nil {
		return c, errors.New("CONFIG_INVALID")
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(b, &fields)
	if _, retired := fields["everything"]; retired {
		return c, errors.New("CONFIG_FIELD_UNSUPPORTED")
	}
	if !c.TestOnly || !filepath.IsAbs(c.InstanceRoot) || !filepath.IsAbs(c.Database) || !Inside(c.InstanceRoot, c.Database) || filepath.Clean(c.InstanceRoot) == filepath.Clean(c.Database) || !Inside(c.InstanceRoot, file) || len(c.Sources) != 9 {
		return c, errors.New("ISOLATED_INSTANCE_REQUIRED")
	}
	if !strings.EqualFold(filepath.Clean(c.Database), filepath.Join(c.InstanceRoot, "live", "catalog.sqlite")) {
		return c, errors.New("INSTANCE_LIVE_DATABASE_REQUIRED")
	}
	if e = NoLinks(c.InstanceRoot); e != nil {
		return c, e
	}
	if e = NoLinks(c.Database); e != nil {
		return c, e
	}
	for id, root := range c.Sources {
		if _, ok := metadata.Versions[id]; !ok || !filepath.IsAbs(root) {
			return c, errors.New("NINE_SOURCE_BINDINGS_REQUIRED")
		}
		if Inside(root, c.InstanceRoot) || Inside(c.InstanceRoot, root) {
			return c, errors.New("SOURCE_RUNTIME_OVERLAP")
		}
		for other, r := range c.Sources {
			if other != id && (Inside(root, r) || Inside(r, root)) {
				return c, errors.New("SOURCE_ROOT_OVERLAP")
			}
		}
	}
	if c.ListingSource == "" {
		c.ListingSource = "filesystem"
	}
	if c.ListingSource != "filesystem" {
		return c, errors.New("LISTING_SOURCE_INVALID")
	}
	if c.Workers == 0 {
		c.Workers = 8
	}
	if c.SlowDeviceWorkers == 0 {
		c.SlowDeviceWorkers = 2
	}
	if c.BatchSize == 0 {
		c.BatchSize = 128
	}
	if c.MetadataLimit == 0 {
		c.MetadataLimit = 64 << 20
	}
	if c.Workers < 1 || c.Workers > 32 || c.SlowDeviceWorkers < 1 || c.SlowDeviceWorkers > 8 || c.BatchSize < 1 || c.BatchSize > 128 || c.MetadataLimit < 1024 || c.MetadataLimit > 128<<20 {
		return c, errors.New("BUDGET_INVALID")
	}
	return c, nil
}
func Join(root, relative string) (string, error) {
	relative = strings.ReplaceAll(relative, "\\", string(filepath.Separator))
	if filepath.IsAbs(relative) || strings.ContainsAny(relative, "\x00:") {
		return "", errors.New("PATH_ESCAPE")
	}
	for _, p := range strings.Split(relative, string(filepath.Separator)) {
		if p == ".." || p == "." {
			return "", errors.New("PATH_ESCAPE")
		}
	}
	p := filepath.Join(root, relative)
	if !Inside(root, p) {
		return "", errors.New("PATH_ESCAPE")
	}
	return p, nil
}
