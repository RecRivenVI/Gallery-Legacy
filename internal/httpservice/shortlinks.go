package httpservice

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/RecRivenVI/Gallery-Legacy/internal/fileview"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

var shortCode = regexp.MustCompile(`^[a-f0-9]{32}$`)

type shortLinks struct {
	root     string
	reserved map[string]string
	mu       sync.Mutex
	codes    map[string]bool
}

func newShortLinks(root string, reserved map[string]string) (*shortLinks, error) {
	if err := library.NoLinks(root); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	s := &shortLinks{root: root, reserved: reserved, codes: map[string]bool{}}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") && shortCode.MatchString(strings.TrimSuffix(e.Name(), ".json")) {
			s.codes[e.Name()] = true
		}
	}
	return s, nil
}
func control(s string) bool {
	for _, r := range s {
		if r < 32 || r == 127 {
			return true
		}
	}
	return false
}
func (s *shortLinks) create(input reading.Row, v *reading.View, files *fileview.Browser) (reading.Row, error) {
	p, ok := input["path"].(string)
	if !ok || len(utf16.Encode([]rune(p))) > 3000 || control(p) {
		return nil, media.Failure("SHORT_LINK_INVALID", 400)
	}
	selected := ""
	if raw := input["media"]; raw != nil {
		str, ok := raw.(string)
		if !ok || len(utf16.Encode([]rune(str))) > 3000 {
			return nil, media.Failure("SHORT_LINK_INVALID", 400)
		}
		var err error
		selected, err = media.Relative(str)
		if err != nil {
			return nil, media.Failure("SHORT_LINK_INVALID", 400)
		}
	}
	if strings.HasPrefix(p, "/p/") {
		if v == nil {
			return nil, media.Failure("SHORT_LINK_TARGET_MISSING", 404)
		}
		found, err := v.Resolve(p)
		if err != nil {
			return nil, err
		}
		if found == nil || found["kind"] != "work" {
			return nil, media.Failure("SHORT_LINK_TARGET_MISSING", 404)
		}
		if selected != "" {
			exists := false
			for _, m := range found["item"].(reading.Row)["media"].([]reading.Row) {
				if m["relativePath"] == selected {
					exists = true
					break
				}
			}
			if !exists {
				return nil, media.Failure("SHORT_LINK_TARGET_MISSING", 404)
			}
		}
	} else if strings.HasPrefix(p, "/f/") {
		parts := strings.Split(p, "/")
		root, rel := parts[2], strings.Join(parts[3:], "/")
		var err error
		if selected != "" {
			_, err = files.Media(root, strings.TrimPrefix(rel+"/"+selected, "/"))
		} else {
			_, err = files.List(root, rel, fileview.Options{Page: 1, Size: 1, Filter: "all", Order: "asc"})
		}
		if err != nil {
			return nil, err
		}
	} else {
		return nil, media.Failure("SHORT_LINK_INVALID", 400)
	}
	parts := strings.Split(p, "/")
	for i := range parts {
		parts[i] = protocol.Component(parts[i])
	}
	target := "/#" + strings.Join(parts, "/")
	if selected != "" {
		target += "?media=" + protocol.Component(selected)
	}
	h := sha256.Sum256([]byte(target))
	code := hex.EncodeToString(h[:])[:32]
	if _, ok := s.reserved[code]; ok {
		return nil, media.Failure("SHORT_LINK_RESERVED", 409)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	name := code + ".json"
	file := filepath.Join(s.root, name)
	if err := library.NoLinks(file); err != nil {
		return nil, err
	}
	if !s.codes[name] {
		if len(s.codes) >= 10000 {
			return nil, media.Failure("SHORT_LINK_LIMIT", 429)
		}
		if err := instance.WriteJSON(file, reading.Row{"version": 1, "target": target}); err != nil {
			return nil, err
		}
		s.codes[name] = true
	} else {
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		var row reading.Row
		if err = json.Unmarshal(b, &row); err != nil {
			return nil, err
		}
		if row["target"] != target {
			return nil, media.Failure("SHORT_LINK_COLLISION", 409)
		}
	}
	return reading.Row{"code": code, "url": "/s/" + code, "target": target}, nil
}
func (s *shortLinks) resolve(code string) (string, error) {
	if value, ok := s.reserved[code]; ok {
		return value, nil
	}
	if !shortCode.MatchString(code) {
		return "", nil
	}
	file := filepath.Join(s.root, code+".json")
	if err := library.NoLinks(file); err != nil {
		return "", err
	}
	b, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var row reading.Row
	if err = json.Unmarshal(b, &row); err != nil {
		return "", err
	}
	target, _ := row["target"].(string)
	if row["version"] == float64(1) && (strings.HasPrefix(target, "/#/p/") || strings.HasPrefix(target, "/#/f/")) && !control(target) {
		return target, nil
	}
	return "", nil
}
