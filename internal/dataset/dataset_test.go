package dataset

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func errorCode(err error) string {
	if err == nil {
		return ""
	}
	return strings.SplitN(err.Error(), ": ", 2)[0]
}
func jsonValue(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var result any
	if err = json.Unmarshal(b, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func equal(t *testing.T, want, got any) {
	t.Helper()
	if !reflect.DeepEqual(want, jsonValue(t, got)) {
		a, _ := json.Marshal(want)
		b, _ := json.Marshal(got)
		t.Fatalf("Node %s\nGo   %s", a, b)
	}
}

func TestNodeDataset(t *testing.T) {
	file := os.Getenv("GALLERY_DATASET_GOLDEN")
	if file == "" {
		t.Skip("run npm run test:dataset for frozen Node differential")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		ConfigFile, Base, GenerationID string
		Cases                          []struct {
			Name, File, Epoch, Code string
			State                   any
			Pages                   []struct {
				Kind, Raw, Code string
				Expected        any
			}
		}
	}
	if err = json.Unmarshal(b, &golden); err != nil {
		t.Fatal(err)
	}
	for _, c := range golden.Cases {
		t.Run(c.Name, func(t *testing.T) {
			d, err := Load(context.Background(), c.File)
			if c.Code != "" {
				if errorCode(err) != c.Code {
					t.Fatalf("Node %s, Go %v", c.Code, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer d.Close()
			if d.Epoch != c.Epoch {
				t.Fatalf("epoch %s/%s", c.Epoch, d.Epoch)
			}
			state, err := d.State(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			equal(t, c.State, state)
			for _, p := range c.Pages {
				t.Run(p.Kind+"/"+p.Raw, func(t *testing.T) {
					params, err := url.ParseQuery(p.Raw)
					if err != nil {
						t.Fatal(err)
					}
					got, err := d.Page(context.Background(), p.Kind, params)
					if p.Code != "" {
						if errorCode(err) != p.Code {
							t.Fatalf("Node %s, Go %v", p.Code, err)
						}
						return
					}
					if err != nil {
						t.Fatal(err)
					}
					equal(t, p.Expected, got)
				})
			}
			if d.Reader != nil {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				if _, err = d.State(ctx); !errors.Is(err, context.Canceled) {
					t.Fatalf("cancel ignored: %v", err)
				}
				if _, err = d.Reader.DB.Exec("UPDATE works SET title='not allowed'"); err == nil {
					t.Fatal("read assembly wrote database")
				}
				if err = d.Close(); err != nil {
					t.Fatal(err)
				}
				if _, err = d.State(context.Background()); err == nil {
					t.Fatal("closed dataset still serves SQL")
				}
				reopened, err := Load(context.Background(), c.File)
				if err != nil {
					t.Fatal(err)
				}
				reopened.Close()
			}
		})
	}
	t.Run("Go initialization then assembled readonly service", func(t *testing.T) {
		data, err := os.ReadFile(golden.ConfigFile)
		if err != nil {
			t.Fatal(err)
		}
		var raw map[string]any
		if err = json.Unmarshal(data, &raw); err != nil {
			t.Fatal(err)
		}
		for _, base := range []*catalog.LiveBase{nil, {CatalogPath: golden.Base, GenerationID: golden.GenerationID}} {
			root := filepath.Join(filepath.Dir(file), "GoInitializedEmpty")
			if base != nil {
				root = filepath.Join(filepath.Dir(file), "GoInitializedRecovered")
			}
			raw["instanceRoot"] = root
			config, err := instance.Normalize(raw)
			if err != nil {
				t.Fatal(err)
			}
			if err = catalog.CreateLiveFrom(context.Background(), root, config.Sources, base); err != nil {
				t.Fatal(err)
			}
			configFile := filepath.Join(root, "config.json")
			data, err = json.Marshal(raw)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(configFile, data, 0600); err != nil {
				t.Fatal(err)
			}
			d, err := Load(context.Background(), configFile)
			if err != nil {
				t.Fatal(err)
			}
			state, err := d.State(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			works := state["counts"].(map[string]any)["works"].(int64)
			if base == nil && works != 0 || base != nil && works == 0 {
				t.Fatalf("unexpected initialization count %d", works)
			}
			d.Close()
		}
	})
	t.Run("same response revision and title across commits", func(t *testing.T) {
		for _, c := range golden.Cases {
			if c.Name == "LiveRecovered" {
				testSnapshot(t, c.File)
			}
		}
	})
}

func testSnapshot(t *testing.T, file string) {
	t.Helper()
	d, err := Load(context.Background(), file)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	writer, err := sql.Open("sqlite", filepath.Join(d.Config.InstanceRoot, "live/catalog.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err = writer.Exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000"); err != nil {
		t.Fatal(err)
	}
	write := func(revision int) {
		tx, err := writer.Begin()
		if err != nil {
			t.Error(err)
			return
		}
		defer tx.Rollback()
		if _, err = tx.Exec("UPDATE live_meta SET revision=?", revision); err != nil {
			t.Error(err)
			return
		}
		if _, err = tx.Exec("UPDATE works SET title=?", strings.Repeat("x", revision)); err != nil {
			t.Error(err)
			return
		}
		if err = tx.Commit(); err != nil {
			t.Error(err)
		}
	}
	write(1)
	var group sync.WaitGroup
	group.Go(func() {
		for i := 2; i <= 24; i++ {
			write(i)
		}
	})
	defer group.Wait()
	for range 32 {
		p, err := d.Page(context.Background(), "works", url.Values{"pageSize": {"2"}})
		if err != nil {
			t.Fatal(err)
		}
		value := jsonValue(t, p).(map[string]any)
		revision := int(value["revision"].(float64))
		for _, item := range value["items"].([]any) {
			title := item.(map[string]any)["title"].(string)
			if title != strings.Repeat("x", revision) {
				t.Fatalf("response mixed title and revision %q/%d", title, revision)
			}
		}
	}
}
