package metadata

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

func Shape(platform string, m Object, wildcard, excluded []string, policy int) string {
	entries := map[string]bool{}
	wild := map[string]bool{}
	skip := map[string]bool{}
	for _, s := range wildcard {
		wild[s] = true
	}
	for _, s := range excluded {
		skip[s] = true
	}
	var visit func(any, string, string)
	visit = func(v any, path, pp string) {
		kind := "null"
		switch v.(type) {
		case Object:
			kind = "object"
		case []any:
			kind = "array"
		case string:
			kind = "string"
		case bool:
			kind = "boolean"
		case json.Number, float64, int64:
			kind = "number"
		}
		entries[path+":"+kind] = true
		if a, ok := v.([]any); ok {
			for _, x := range a {
				visit(x, path+"[]", pp+"[]")
			}
		}
		if o, ok := v.(Object); ok {
			for _, k := range Keys(o) {
				next := pp + "." + k
				canon := path + "[" + JSON(k) + "]"
				if wild[pp] {
					next = pp + ".*"
					canon = path + "[*]"
				}
				if !skip[next] {
					visit(o[k], canon, next)
				}
			}
		}
	}
	visit(m, "$", "$")
	parts := []string{}
	for s := range entries {
		parts = append(parts, s)
	}
	sort.Strings(parts)
	header := fmt.Sprintf("metadata-shape-signature:1\nplatform:%s\npolicy:%d\n", JSON(platform), policy)
	sum := sha256.Sum256([]byte(header + strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:])
}
func JSON(v any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	return strings.TrimSuffix(b.String(), "\n")
}
