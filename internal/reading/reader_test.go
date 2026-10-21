package reading

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strconv"
	"sync"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
)

func TestNodeReaderDifferential(t *testing.T) {
	file := os.Getenv("GALLERY_READER_GOLDEN")
	if file == "" {
		t.Skip("run the reader differential scenario for Node golden results")
	}
	bytes, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Database, Epoch, Search string
		Live                    bool
		Cases                   []struct {
			Name, Operation, Path, MediaType, Kind, Raw string
			Revision                                    *int64
			IDs                                         []string
			ID                                          string
			Expected                                    any
		}
	}
	if err = json.Unmarshal(bytes, &golden); err != nil {
		t.Fatal(err)
	}
	var reader *Reader
	if golden.Live {
		reader, err = Open(context.Background(), golden.Database, golden.Epoch, true)
	} else {
		reader, err = OpenStatic(context.Background(), golden.Database, golden.Search, golden.Epoch)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if len(golden.Cases) == 0 {
		t.Fatal("reference cases required")
	}
	for _, c := range golden.Cases {
		t.Run(c.Name, func(t *testing.T) {
			ids := []int64{}
			for _, value := range c.IDs {
				n, err := strconv.ParseInt(value, 10, 64)
				if err != nil {
					t.Fatal(err)
				}
				ids = append(ids, n)
			}
			var itemID int64
			if c.ID != "" {
				itemID, err = strconv.ParseInt(c.ID, 10, 64)
				if err != nil {
					t.Fatal(err)
				}
			}
			actual, err := reader.Snapshot(context.Background(), func(v *View) (any, error) {
				switch c.Operation {
				case "page":
					return v.Page(c.Kind, protocol.Parameters(c.Raw), c.Revision)
				case "stats":
					return v.Stats()
				case "platformStats":
					return v.PlatformStats()
				case "works":
					return v.Works(ids, c.MediaType)
				case "work":
					return v.Work(itemID)
				case "authors":
					return v.Authors(ids)
				case "resolve":
					return v.Resolve(c.Path)
				case "chapters":
					return v.Chapters(c.Path)
				case "mediaPath":
					return v.MediaAtPath(c.Path)
				case "identity":
					m, err := v.Media(itemID)
					if err != nil {
						return nil, err
					}
					if m == nil {
						return nil, nil
					}
					return mediaIdentity(m), nil
				default:
					t.Fatalf("unknown operation %s", c.Operation)
					return nil, nil
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(actual)
			if err != nil {
				t.Fatal(err)
			}
			var comparable any
			if err = json.Unmarshal(encoded, &comparable); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(comparable, c.Expected) {
				t.Fatal(firstDifference("$", c.Expected, comparable))
			}
		})
	}
	if golden.Live {
		t.Run("readonly cancellation and transaction snapshot", func(t *testing.T) {
			testLiveSnapshot(t, reader, golden.Database)
		})
	}
}

func testLiveSnapshot(t *testing.T, reader *Reader, file string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := reader.Snapshot(ctx, func(v *View) (any, error) { return v.Stats() }); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled request continued: %v", err)
	}
	_, err := reader.Snapshot(context.Background(), func(v *View) (any, error) {
		_, err := v.tx.ExecContext(v.ctx, "UPDATE live_meta SET revision=revision+1")
		return nil, err
	})
	if err == nil {
		t.Fatal("reader connection wrote to catalog")
	}
	writer, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err = writer.Exec("PRAGMA synchronous=FULL"); err != nil {
		t.Fatal(err)
	}
	_, err = reader.Snapshot(context.Background(), func(v *View) (any, error) {
		var before, after int64
		if err := v.tx.QueryRowContext(v.ctx, "SELECT revision FROM live_meta").Scan(&before); err != nil {
			return nil, err
		}
		if _, err := writer.Exec("UPDATE live_meta SET revision=revision+1"); err != nil {
			return nil, err
		}
		if err := v.tx.QueryRowContext(v.ctx, "SELECT revision FROM live_meta").Scan(&after); err != nil {
			return nil, err
		}
		if before != after {
			t.Fatalf("one response mixed revisions %d/%d", before, after)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for range 8 {
		group.Go(func() {
			_, err := reader.Snapshot(context.Background(), func(v *View) (any, error) { return v.Stats() })
			if err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
}

func firstDifference(path string, want, got any) string {
	if reflect.DeepEqual(want, got) {
		return ""
	}
	switch w := want.(type) {
	case map[string]any:
		if g, ok := got.(map[string]any); ok {
			keys := []string{}
			for key := range w {
				keys = append(keys, key)
			}
			for key := range g {
				if _, ok := w[key]; !ok {
					keys = append(keys, key)
				}
			}
			sort.Strings(keys)
			for _, key := range keys {
				if message := firstDifference(path+"."+key, w[key], g[key]); message != "" {
					return message
				}
			}
		}
	case []any:
		if g, ok := got.([]any); ok {
			if len(w) != len(g) {
				return fmt.Sprintf("%s length: Node=%d Go=%d", path, len(w), len(g))
			}
			for i := range w {
				if message := firstDifference(fmt.Sprintf("%s[%d]", path, i), w[i], g[i]); message != "" {
					return message
				}
			}
		}
	}
	return fmt.Sprintf("%s: Node=%v Go=%v", path, want, got)
}

func TestReaderDoesNotCreateMissingDatabase(t *testing.T) {
	file := t.TempDir() + "/missing.sqlite"
	if reader, err := Open(context.Background(), file, "empty", false); err == nil {
		reader.Close()
		t.Fatal("missing database accepted")
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("missing database was created: %v", err)
	}
}
