package recovery

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
)

func TestNodeRecoveryDifferential(t *testing.T) {
	file := os.Getenv("GALLERY_RECOVERY_GOLDEN")
	if file == "" {
		t.Skip("run recovery differential for frozen Node results")
	}
	bytes, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Cases []struct {
			Name, Operation, Instance string
			Code                      *string
			Expected                  any
		}
		Validations []struct {
			Name, File string
			Code       *string
			Expected   any
		}
		Restores []struct {
			Name, Instance, Base, GenerationID string
			Legacy                             *int
			Sources                            map[string]string
			Expected                           map[string]any
			Tables                             []string
		}
	}
	if err = json.Unmarshal(bytes, &golden); err != nil {
		t.Fatal(err)
	}
	for _, c := range golden.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var value *Checkpoint
			var err error
			if c.Operation == "active" {
				value, err = Active(context.Background(), c.Instance, "", "")
			} else {
				value, err = Open(context.Background(), c.Instance, "", "first")
			}
			assertCode(t, c.Code, err)
			if err == nil {
				assertJSON(t, c.Expected, map[string]any{"generationId": value.GenerationID, "facts": value.Facts})
			}
		})
	}
	for _, c := range golden.Validations {
		t.Run(c.Name, func(t *testing.T) {
			db, err := existingReadOnly(context.Background(), c.File)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			value, err := catalog.Validate(context.Background(), db, false)
			assertCode(t, c.Code, err)
			if err == nil {
				assertJSON(t, c.Expected, value)
			}
		})
	}
	for _, c := range golden.Restores {
		t.Run(c.Name, func(t *testing.T) {
			if c.Legacy == nil {
				err = catalog.CreateLiveFrom(context.Background(), c.Instance, c.Sources, &catalog.LiveBase{CatalogPath: c.Base, GenerationID: c.GenerationID})
			} else {
				db, e := sql.Open("sqlite", filepath.Join(c.Instance, "live/catalog.sqlite"))
				if e != nil {
					t.Fatal(e)
				}
				_, e = db.Exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON")
				if e != nil {
					t.Fatal(e)
				}
				_, err = catalog.UpgradeLive(context.Background(), db, c.Sources)
				db.Close()
			}
			if err != nil {
				t.Fatal(err)
			}
			db, err := existingReadOnly(context.Background(), filepath.Join(c.Instance, "live/catalog.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err = catalog.ReadLiveState(context.Background(), db); err != nil {
				t.Fatal(err)
			}
			if _, err = catalog.Validate(context.Background(), db, true); err != nil {
				t.Fatal(err)
			}
			actual := map[string]any{}
			for _, table := range c.Tables {
				actual[table] = textRows(t, db, table)
			}
			for _, value := range c.Expected {
				list := value.([]any)
				sort.Slice(list, func(i, j int) bool {
					a, _ := json.Marshal(list[i])
					b, _ := json.Marshal(list[j])
					return string(a) < string(b)
				})
			}
			assertJSON(t, c.Expected, actual)
		})
	}
}

func assertCode(t *testing.T, want *string, err error) {
	t.Helper()
	if want == nil {
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	if err == nil || strings.Split(err.Error(), ":")[0] != *want {
		t.Fatalf("Node=%s Go=%v", *want, err)
	}
}
func assertJSON(t *testing.T, want, got any) {
	t.Helper()
	a, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var comparable any
	if err = json.Unmarshal(a, &comparable); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, comparable) {
		t.Fatalf("different projection: Node=%v Go=%v", want, comparable)
	}
}
func textRows(t *testing.T, db *sql.DB, table string) []map[string]any {
	t.Helper()
	rows, err := db.Query("SELECT * FROM " + table)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	result := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(names))
		pointers := make([]any, len(names))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err = rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		row := map[string]any{}
		for i, name := range names {
			if table == "live_meta" && (name == "epoch" || name == "initialized_at_ms") {
				continue
			}
			switch v := values[i].(type) {
			case int64:
				row[name] = strconv.FormatInt(v, 10)
			default:
				row[name] = v
			}
		}
		result = append(result, row)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	// SQLite row visitation order is not part of the storage contract.
	sort.Slice(result, func(i, j int) bool {
		a, _ := json.Marshal(result[i])
		b, _ := json.Marshal(result[j])
		return string(a) < string(b)
	})
	return result
}
