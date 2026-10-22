package api

import (
	_ "embed"
	"encoding/json"
)

//go:embed inspection-checks.json
var inspectionJSON []byte

type Check struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Severity string `json:"severity"`
}

func LoadChecks() ([]Check, error) {
	var checks []Check
	err := json.Unmarshal(inspectionJSON, &checks)
	return checks, err
}
