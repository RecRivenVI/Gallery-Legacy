package metadata

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/api"
	"io"
	"sort"
)

type Object = map[string]any
type Text struct{ Role, SourcePath, SourceFormat, SourceText string }
type Relation struct{ Type, SourceID string }
type Evidence struct {
	Field, Kind, Path string
	Priority          int
}
type Result struct {
	platform                              string
	Valid                                 bool
	Reason                                string
	Work, Profile, Flags, Access, Metrics Object
	Tags                                  []string
	Primary                               *Text
	Supplementary                         []Text
	Structured                            []Object
	Relations                             []Relation
	Evidence                              []Evidence
	Warnings                              int
	InvalidFields                         int
	Issues                                []FieldIssue
	Details                               Details
	AuthorLinks                           []AuthorLink
}

type FieldIssue struct {
	Path, Reason string
}

var Versions = func() map[string]int {
	contract, err := api.LoadCatalog()
	if err != nil {
		panic(fmt.Errorf("embedded catalog contract: %w", err))
	}
	versions := make(map[string]int, len(contract.Platforms))
	for _, platform := range contract.Platforms {
		versions[platform.ID] = platform.AdapterVersion
	}
	return versions
}()

func Parse(platform, author, work string, raw []byte) (Result, Object) {
	r := New()
	r.platform = platform
	var value any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if e := d.Decode(&value); e != nil {
		r.Valid = false
		r.Reason = "malformed_json"
		r.identity(Object{}, author, work, nil, nil)
		return r, nil
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		r.Valid = false
		r.Reason = "malformed_json"
		return r, nil
	}
	m, ok := value.(map[string]any)
	if !ok {
		r.Valid = false
		r.Reason = "metadata_not_object"
		r.identity(Object{}, author, work, nil, nil)
		return r, nil
	}
	if platform != "Venera" {
		// Identity aliases are validated together by field selection.
		idPaths := map[string][]string{"X": {"reply_id", "retweet_id", "quoted_id", "conversation_id"}}[platform]
		for _, path := range idPaths {
			v := Get(m, path)
			if v != nil && v != "" && ID(v) == nil {
				r.reject(path, "invalid_id")
			}
		}
		for _, p := range []string{"postUrl", "post_url", "url", "sourceUrl", "source_url", "permalink", "link", "source.url"} {
			if v := SafeLink(Get(m, p)); v != nil {
				r.Work["sourceUrl"] = v
				r.Supplementary = append(r.Supplementary, Text{"source_link", "$." + p, "plain", String(v)})
				r.Evidence = append(r.Evidence, Evidence{"work.sourceUrl", "metadata", "$." + p, 1})
				break
			}
		}
	}
	applyFields(&r, m, platform, author, work)
	platformExtras(&r, m, platform, author, work)
	parseDetails(&r, m, platform)
	sort.Slice(r.Evidence, func(i, j int) bool {
		a, b := r.Evidence[i], r.Evidence[j]
		if a.Field != b.Field {
			return a.Field < b.Field
		}
		if a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.Path < b.Path
	})
	return r, m
}
