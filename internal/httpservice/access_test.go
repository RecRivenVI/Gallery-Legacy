package httpservice

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func TestFrozenAccessHistory(t *testing.T) {
	file := os.Getenv("GALLERY_HTTP_GOLDEN")
	if file == "" {
		t.Skip("frozen HTTP capture required")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Access []struct {
			Name            string
			Now             int64
			Saved, Expected reading.Row
			Requests        []struct {
				IP, Method, Path, Agent string
				Status                  int
				Bytes                   int64
				Allowed                 bool
				Flush                   bool
			}
		}
	}
	if err = json.Unmarshal(b, &golden); err != nil {
		t.Fatal(err)
	}
	if len(golden.Access) == 0 {
		t.Fatal("access oracle absent")
	}
	for _, c := range golden.Access {
		t.Run(c.Name, func(t *testing.T) {
			root, err := os.MkdirTemp(filepath.Dir(file), "AccessGo-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if !t.Failed() {
					if err := instance.Recycle(root); err != nil {
						t.Error(err)
					}
				}
			})
			config := instance.Config{StateRoot: root, InstanceID: "synthetic-http"}
			if c.Saved != nil {
				if err := instance.WriteJSON(filepath.Join(root, "access-history.json"), c.Saved); err != nil {
					t.Fatal(err)
				}
			}
			a, err := newAccess(config, func() time.Time { return time.UnixMilli(c.Now) })
			if err != nil {
				t.Fatal(err)
			}
			for _, request := range c.Requests {
				r := httptest.NewRequest(request.Method, "http://localhost"+request.Path, nil)
				r.RemoteAddr = request.IP + ":1000"
				r.Header.Set("User-Agent", request.Agent)
				allowed, finish := a.begin(r)
				if allowed != request.Allowed {
					t.Errorf("blocking %s: Node %v Go %v", request.IP, request.Allowed, allowed)
				}
				if request.Flush {
					if err := a.flush(); err != nil {
						t.Fatal(err)
					}
				}
				finish(request.Status, request.Bytes)
			}
			if err := a.close(); err != nil {
				t.Fatal(err)
			}
			bytes, err := os.ReadFile(a.file)
			if err != nil {
				t.Fatal(err)
			}
			var got reading.Row
			if err = json.Unmarshal(bytes, &got); err != nil {
				t.Fatal(err)
			}
			for _, event := range got["events"].([]any) {
				event.(map[string]any)["elapsedMs"] = float64(0)
			}
			equalJSON(t, c.Expected, got)
		})
	}
}
