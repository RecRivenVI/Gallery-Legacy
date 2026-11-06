package api

import (
	_ "embed"
	"encoding/json"
)

// ProtocolJSON is served without reserialization, as by the Node reference.
//
//go:embed protocol.json
var ProtocolJSON []byte

func Load() (Protocol, error) {
	var contract Protocol
	err := json.Unmarshal(ProtocolJSON, &contract)
	return contract, err
}
