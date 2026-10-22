package host

import (
	"encoding/json"
	"regexp"

	"github.com/RecRivenVI/Gallery-Legacy/api"
)

var privateKey = regexp.MustCompile(`(?i)(identity|path|root|source|text|title|name|url|token|secret|config|handle)`)

func summarize(v any, depth int) any {
	if depth > 6 {
		return nil
	}
	switch value := v.(type) {
	case nil, bool, float64:
		return value
	case string:
		if regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`).MatchString(value) {
			return value
		}
		for _, s := range []string{"info", "warn", "error", "debug", "full", "incremental", "ready", "missing", "partial", "valid", "unavailable", "platform-sample", "selected-author"} {
			if s == value {
				return value
			}
		}
		contract, _ := api.LoadCatalog()
		for _, p := range contract.Platforms {
			if p.ID == value {
				return value
			}
		}
		return nil
	case []any:
		result := []any{}
		for _, v := range value[:min(30, len(value))] {
			result = append(result, summarize(v, depth+1))
		}
		return result
	case map[string]any:
		result := Row{}
		for k, v := range value {
			if !privateKey.MatchString(k) {
				s := summarize(v, depth+1)
				if s != nil || v == nil {
					result[k] = s
				}
			}
		}
		return result
	}
	return nil
}
func redactLog(line string) string {
	if line == "" || regexp.MustCompile(`^[A-Z0-9_]{1,64}$`).MatchString(line) {
		return line
	}
	var v any
	if json.Unmarshal([]byte(line), &v) != nil {
		return "[非结构化日志已隐藏；可在本机打开日志目录查看]"
	}
	b, _ := json.Marshal(summarize(v, 0))
	return string(b)
}
