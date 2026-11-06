package api

import (
	_ "embed"
	"encoding/json"
	"strings"
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

//go:embed search.sql
var searchSQL string

func SearchSQL(prefix string) string { return strings.ReplaceAll(searchSQL, "__prefix__", prefix) }

var LiveSearchSQL = SearchSQL("live_") + "CREATE INDEX live_idx_relation_target_all ON social_relations(target_platform_id,target_source_work_id);"

//go:embed live-ledger.sql
var LiveLedgerSQL string

//go:embed live-profiles.sql
var LiveProfilesSQL string

//go:embed enrichment.sql
var EnrichmentSQL string

//go:embed inventory.sql
var InventorySQL string

var StaticSearchSQL = `CREATE TABLE index_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,catalog_work_count INTEGER NOT NULL,catalog_sha256 TEXT NOT NULL,catalog_size INTEGER NOT NULL,catalog_mtime_ms INTEGER NOT NULL,built_at_ms INTEGER NOT NULL);` + SearchSQL("")

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
