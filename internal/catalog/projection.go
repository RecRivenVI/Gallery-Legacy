package catalog

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"fmt"
)

func init() {
	gob.Register(map[string]any{})
	gob.Register([]any{})
	gob.Register([]map[string]any{})
	gob.Register(json.Number(""))
}

// The live-only projection lets author selection reuse an unchanged work
// without reopening its metadata. It commits and disappears with its ledger.
func EncodeAuthority(p PreparedWork) ([]byte, error) {
	var b bytes.Buffer
	err := gob.NewEncoder(&b).Encode(Authority(p))
	if err != nil {
		return nil, fmt.Errorf("encode profile projection: %w", err)
	}
	return b.Bytes(), nil
}

func DecodeAuthority(b []byte) (PreparedWork, error) {
	var p PreparedWork
	err := gob.NewDecoder(bytes.NewReader(b)).Decode(&p)
	if err != nil {
		return p, fmt.Errorf("decode profile projection: %w", err)
	}
	return p, nil
}
