package instance

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestNodeConfiguration(t *testing.T) {
	file := os.Getenv("GALLERY_CONFIG_GOLDEN")
	if file == "" {
		t.Skip("run npm run test:config for frozen Node differential")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		File     string
		Source   map[string]any
		Expected any
		Code     string
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var config Config
			var err error
			if c.File != "" {
				config, err = Load(c.File)
			} else {
				config, err = Normalize(c.Source)
			}
			if c.Code != "" {
				if err == nil || strings.SplitN(err.Error(), ": ", 2)[0] != c.Code {
					t.Fatalf("Node code %q, Go error %v", c.Code, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			b, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			var actual any
			if err = json.Unmarshal(b, &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, c.Expected) {
				t.Fatalf("Node %s\nGo   %s", mustJSON(c.Expected), b)
			}
		})
	}
}
func mustJSON(value any) string { b, _ := json.Marshal(value); return string(b) }

func TestRetiredInventoryIsNotEnabled(t *testing.T) {
	_, err := Normalize(map[string]any{"instanceRoot": t.TempDir(), "everything": map[string]any{"endpoint": "http://127.0.0.1:54321/"}})
	if err == nil || err.Error() != "CONFIG_FIELD_UNSUPPORTED" {
		t.Fatalf("legacy inventory endpoint accepted: %v", err)
	}
}
