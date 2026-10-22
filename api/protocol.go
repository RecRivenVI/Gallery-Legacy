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

// ProtocolJSON is served without reserialization, as by the Node reference.
//
//go:embed protocol.json
var ProtocolJSON []byte

func Load() (Protocol, error) {
	var contract Protocol
	err := json.Unmarshal(ProtocolJSON, &contract)
	return contract, err
}
