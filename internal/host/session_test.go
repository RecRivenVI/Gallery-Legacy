package host

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func TestConnectionReadsSavedConfigurationWhileStopped(t *testing.T) {
	file := filepath.Join(t.TempDir(), "config.json")
	def, err := api.LoadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	sources := Row{}
	for _, p := range def.Platforms {
		sources[p.ID] = filepath.Join(filepath.Dir(file), "sources", p.ID)
	}
	write := func(port int) {
		t.Helper()
		b, err := json.Marshal(Row{"instanceRoot": filepath.Join(filepath.Dir(file), "instance"), "port": port, "sources": sources})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(18420)
	initial, err := instance.Load(file)
	if err != nil {
		t.Fatal(err)
	}
	s := Session{config: initial, options: Options{ConfigFile: file}}
	write(18422)
	got, err := s.command("connection", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.(Row)["url"] != "http://127.0.0.1:18422" {
		t.Fatalf("stale connection after save: %v", got)
	}
}
