package metadata

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestPublicCorpusParity(t *testing.T) {
	file := os.Getenv("GALLERY_GO_GOLDEN")
	if file == "" {
		t.Fatal("GALLERY_GO_GOLDEN synthetic oracle required")
	}
	b, e := os.ReadFile(file)
	if e != nil {
		t.Fatal(e)
	}
	var cases []struct {
		Platform, Name, Author, Work, Raw, Shape string
		Expected                                 Object
		Policy                                   struct {
			WildcardObjectPaths, ExcludedPaths []string
			SHAPE_POLICY_VERSION               int
		}
	}
	if e = json.Unmarshal(b, &cases); e != nil {
		t.Fatal(e)
	}
	for _, c := range cases {
		t.Run(c.Platform+"/"+c.Name, func(t *testing.T) {
			r, m := Parse(c.Platform, c.Author, c.Work, []byte(c.Raw))
			expectedWork := Obj(c.Expected["work"])
			expectedProfile := Obj(c.Expected["authorProfile"])
			// Null fields and omitted fields mean the same optional value. Compare every
			// current normalized scalar, not selected hand-picked happy-path fields.
			pairs := [][2]Object{{r.Work, expectedWork}, {r.Profile, expectedProfile}, {r.Flags, Obj(expectedWork["flags"])}, {r.Access, Obj(expectedWork["access"])}, {r.Metrics, Obj(c.Expected["metrics"])}}
			for i, p := range pairs {
				for k, want := range p[1] {
					if k == "flags" || k == "access" {
						continue
					}
					got := p[0][k]
					a, _ := json.Marshal(got)
					b, _ := json.Marshal(want)
					if string(a) != string(b) {
						t.Errorf("group %d %s: got %s want %s", i, k, a, b)
					}
				}
			}
			tags := []string{}
			for _, v := range Arr(c.Expected["tags"], false) {
				tags = append(tags, String(Obj(v)["displayValue"]))
			}
			if !reflect.DeepEqual(r.Tags, tags) {
				t.Errorf("tags mismatch %v %v", r.Tags, tags)
			}
			if r.Valid != c.Expected["valid"] {
				t.Errorf("valid mismatch")
			}
			rich := Obj(c.Expected["richText"])
			asText := func(v *Text) any {
				if v == nil {
					return nil
				}
				return Object{"role": v.Role, "sourcePath": v.SourcePath, "sourceFormat": v.SourceFormat, "sourceText": v.SourceText}
			}
			check := func(name string, got, want any) {
				a, _ := json.Marshal(got)
				b, _ := json.Marshal(want)
				if string(a) != string(b) {
					t.Errorf("%s mismatch got %s want %s", name, a, b)
				}
			}
			check("primary", asText(r.Primary), rich["primary"])
			supp := []any{}
			for _, x := range r.Supplementary {
				supp = append(supp, asText(&x))
			}
			check("supplementary", supp, rich["supplementary"])
			decls := []any{}
			for _, d := range r.Declarations {
				refs := []any{}
				for _, ref := range d.References {
					refs = append(refs, Object{"kind": ref.Kind, "value": ref.Value, "sourcePath": ref.SourcePath})
				}
				decls = append(decls, Object{"sourceId": d.SourceID, "kind": d.Kind, "name": d.Name, "url": d.URL, "hash": d.Hash, "size": d.Size, "durationMs": d.Duration, "fileReferences": refs})
			}
			check("declarations", decls, c.Expected["mediaDeclarations"])
			if m != nil {
				shape := Shape(c.Platform, m, c.Policy.WildcardObjectPaths, c.Policy.ExcludedPaths, c.Policy.SHAPE_POLICY_VERSION)
				if shape != c.Shape {
					t.Errorf("shape mismatch %s %s", shape, c.Shape)
				}
			}
		})
	}
}
func TestMalformedAndUnsafeIDs(t *testing.T) {
	for _, raw := range []string{"{}garbage", "{}{}", "[]", "null", "{bad"} {
		r, _ := Parse("pixiv", "700", "plain", []byte(raw))
		if r.Valid {
			t.Fatal("invalid JSON accepted")
		}
	}
	r, _ := Parse("pixiv", "author", "work", []byte(`{"id":9007199254740993,"user":{"id":"9007199254740993123"}}`))
	if r.Work["sourceWorkId"] != nil || r.Profile["sourceAuthorId"] != "9007199254740993123" {
		t.Fatal("unsafe ID conversion")
	}
}
