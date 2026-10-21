package api

import (
	_ "embed"
	"encoding/json"
)

// Protocol contains the cross-implementation values used by the browser too.
type Protocol struct {
	Version      int      `json:"version"`
	WorkSorts    []string `json:"workSorts"`
	AuthorSorts  []string `json:"authorSorts"`
	MediaFilters []string `json:"mediaFilters"`
}

//go:embed protocol.json
var definition []byte

func Load() (Protocol, error) {
	var contract Protocol
	err := json.Unmarshal(definition, &contract)
	return contract, err
}
