package protocol

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
)

func TestNodeQueryDifferential(t *testing.T) {
	file := os.Getenv("GALLERY_PROTOCOL_GOLDEN")
	if file == "" {
		t.Skip("run the protocol differential scenario to create Node golden evidence")
	}
	bytes, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Kind, Raw, Generation string
		Revision                    *int64
		Expected                    map[string]any
	}
	if err = json.Unmarshal(bytes, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("Node reference cases missing")
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			query, err := ParseQuery(Parameters(c.Raw), c.Kind, c.Generation, c.Revision)
			var result any
			if err != nil {
				var boundary *Error
				if !errors.As(err, &boundary) {
					t.Fatal(err)
				}
				result = map[string]any{"code": boundary.Code, "status": boundary.Status}
			} else {
				result = map[string]any{"query": query}
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			var actual map[string]any
			if err = json.Unmarshal(encoded, &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, c.Expected) {
				t.Fatalf("Node/Go differ\nNode: %v\nGo: %v", c.Expected, actual)
			}
		})
	}
}

func TestIdentifiersPreserveSigned64BitBoundary(t *testing.T) {
	for _, value := range []string{"0", "-1", "9223372036854775808", "1.0", "1e3", ""} {
		if _, err := Identifier(value); err == nil {
			t.Errorf("accepted invalid ID %q", value)
		}
	}
	if id, err := Identifier("9223372036854775807"); err != nil || id != 9223372036854775807 {
		t.Fatalf("maximum ID: %d %v", id, err)
	}
}
