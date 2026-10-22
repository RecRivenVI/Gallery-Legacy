package api

import _ "embed"

//go:embed runtime-config.schema.json
var ConfigurationSchema []byte
