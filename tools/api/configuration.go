package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

type jsonField struct {
	Type       string               `json:"type"`
	Default    json.RawMessage      `json:"default"`
	Properties map[string]jsonField `json:"properties"`
	Items      *jsonField           `json:"items"`
}

// The instance schema is also the client configuration's only field/default source.
func configurationModels() ([]model, error) {
	data, err := os.ReadFile("runtime-config.schema.json")
	if err != nil {
		return nil, err
	}
	var schema jsonField
	if err = json.Unmarshal(data, &schema); err != nil {
		return nil, err
	}
	var models []model
	var visit func(string, jsonField) (string, error)
	visit = func(name string, node jsonField) (string, error) {
		switch node.Type {
		case "integer":
			return "long", nil
		case "boolean":
			return "bool", nil
		case "array":
			typ, err := visit(name+"Entry", *node.Items)
			if err != nil {
				return "", err
			}
			if typ == "string" {
				return "strings", nil
			}
			return "list:" + typ, nil
		case "object":
			if len(node.Properties) == 0 {
				return "stringMap", nil
			}
			keys := make([]string, 0, len(node.Properties))
			for key := range node.Properties {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			m := model{Name: name}
			for _, key := range keys {
				child := node.Properties[key]
				title := strings.ToUpper(key[:1]) + key[1:]
				typ, err := visit(name+title, child)
				if err != nil {
					return "", err
				}
				fallback := string(child.Default)
				if fallback != "" && typ == "long" {
					fallback += "L"
				}
				m.Fields = append(m.Fields, field{Name: key, Go: title, Type: typ, Default: fallback})
			}
			models = append(models, m)
			return name, nil
		case "", "string":
			return "string", nil
		default:
			return "", fmt.Errorf("unsupported configuration type %s", node.Type)
		}
	}
	_, err = visit("RuntimeConfiguration", schema)
	return models, err
}
