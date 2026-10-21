package recovery

import (
	"encoding/json"
	"math"
)

// Decode file fields without coercing strings into numbers. The error is
// selected later, in the same field order as the existing manifest contract.
func (m *Manifest) UnmarshalJSON(bytes []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(bytes, &fields); err != nil {
		return err
	}
	m.Version = int(number(fields["manifestVersion"]))
	m.GenerationID = text(fields["generationId"])
	m.State = text(fields["state"])
	m.Catalog, m.invalidCatalogIdentity, m.invalidCatalogBinding = section(fields["catalog"])
	m.Search, m.invalidSearchIdentity, m.invalidSearchBinding = section(fields["search"])
	final := object(fields["finalization"])
	m.Finalization.Version = int(number(final["version"]))
	m.Finalization.Catalog = finalized(final["catalog"])
	m.Finalization.Search = finalized(final["search"])
	validation := object(fields["validation"])
	m.Validation.Catalog = text(validation["catalog"])
	m.Validation.Search = text(validation["search"])
	m.Validation.CrossGenerationBinding = text(validation["crossGenerationBinding"])
	return nil
}

func object(raw json.RawMessage) map[string]json.RawMessage {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}
	return fields
}
func text(raw json.RawMessage) string {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return value
}
func number(raw json.RawMessage) int64 {
	value, valid := integer(raw)
	if !valid {
		return 0
	}
	return value
}
func integer(raw json.RawMessage) (int64, bool) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	n, ok := value.(float64)
	if !ok || math.Trunc(n) != n || n < -9007199254740991 || n > 9007199254740991 {
		return 0, false
	}
	return int64(n), true
}
func section(raw json.RawMessage) (Section, bool, bool) {
	f := object(raw)
	value := Section{RelativePath: text(f["relativePath"]), SchemaVersion: int(number(f["schemaVersion"])), IndexVersion: int(number(f["indexVersion"]))}
	value.SHA256 = text(f["sha256"])
	var size, mtime, works, count, cs, cm bool
	value.SizeBytes, size = integer(f["sizeBytes"])
	value.MtimeMS, mtime = integer(f["mtimeMs"])
	value.WorkCount, works = integer(f["workCount"])
	value.CatalogWorkCount, count = integer(f["catalogWorkCount"])
	value.CatalogSizeBytes, cs = integer(f["catalogSizeBytes"])
	value.CatalogMtimeMS, cm = integer(f["catalogMtimeMs"])
	invalidBinding := !works
	if value.RelativePath == searchRelative {
		invalidBinding = !count || !cs || !cm
	}
	return value, !size || !mtime, invalidBinding
}
func finalized(raw json.RawMessage) FinalizedFile {
	f := object(raw)
	value := FinalizedFile{JournalMode: text(f["journalMode"])}
	var sidecars any
	if err := json.Unmarshal(f["sidecars"], &sidecars); err == nil {
		if b, ok := sidecars.(bool); ok {
			value.Sidecars = &b
		}
	}
	return value
}
