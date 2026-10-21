package api

import (
	_ "embed"
	"encoding/json"
)

type Platform struct {
	ID                 string `json:"id"`
	Family             string `json:"family"`
	Enabled            bool   `json:"enabled"`
	AdapterVersion     int    `json:"adapterVersion"`
	ShapePolicyVersion int    `json:"shapePolicyVersion"`
}

type Catalog struct {
	SchemaVersion            int        `json:"schemaVersion"`
	LiveSchemaVersion        int        `json:"liveSchemaVersion"`
	SearchVersion            int        `json:"searchVersion"`
	AdapterContractVersion   int        `json:"adapterContractVersion"`
	ShapeSignatureVersion    int        `json:"shapeSignatureVersion"`
	AuthorityContractVersion int        `json:"authorityContractVersion"`
	Tables                   []string   `json:"tables"`
	Indexes                  []string   `json:"indexes"`
	Platforms                []Platform `json:"platforms"`
}

//go:embed catalog.json
var catalogDefinition []byte

//go:embed catalog.sql
var CatalogSQL string

//go:embed live-core.sql
var LiveCoreSQL string

//go:embed live-stats.sql
var LiveStatsSQL string

//go:embed live-search.sql
var LiveSearchSQL string

//go:embed live-ledger.sql
var LiveLedgerSQL string

type CatalogCheck struct {
	SQL, Code, Message string
}

//go:embed catalog-checks.json
var catalogChecks []byte

func LoadCatalogChecks() ([]CatalogCheck, error) {
	var checks []CatalogCheck
	err := json.Unmarshal(catalogChecks, &checks)
	return checks, err
}

func LoadCatalog() (Catalog, error) {
	var contract Catalog
	err := json.Unmarshal(catalogDefinition, &contract)
	return contract, err
}
