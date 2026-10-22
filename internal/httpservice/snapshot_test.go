package httpservice

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/dataset"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func TestFrozenHTTPRevisionSnapshot(t *testing.T) {
	file := os.Getenv("GALLERY_HTTP_GOLDEN")
	if file == "" {
		t.Skip("synthetic HTTP input required")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Cases []struct{ Name, ConfigFile string }
	}
	if err = json.Unmarshal(b, &golden); err != nil {
		t.Fatal(err)
	}
	var source string
	for _, c := range golden.Cases {
		if c.Name == "Static" {
			source = c.ConfigFile
		}
	}
	base, err := dataset.Load(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	root, err := os.MkdirTemp(filepath.Dir(file), "Snapshot-")
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
	sources := reading.Row{}
	for k, v := range base.Config.Sources {
		sources[k] = v
	}
	config, err := instance.Normalize(reading.Row{"instanceRoot": root, "sources": sources, "liveUpdates": true, "port": float64(18104)})
	if err != nil {
		t.Fatal(err)
	}
	if err = catalog.CreateLiveFrom(context.Background(), root, config.Sources, &catalog.LiveBase{CatalogPath: base.Generation.CatalogPath, GenerationID: base.Generation.GenerationID}); err != nil {
		t.Fatal(err)
	}
	d, err := dataset.Open(context.Background(), config, base.Generation)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(d, Options{})
	if err != nil {
		d.Close()
		t.Fatal(err)
	}
	host := httptest.NewServer(s)
	defer func() {
		host.Close()
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	}()
	writer, err := sql.Open("sqlite", filepath.Join(root, "live/catalog.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	writer.SetMaxOpenConns(1)
	if _, err = writer.Exec("PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000"); err != nil {
		t.Fatal(err)
	}
	write := func(revision int) error {
		tx, err := writer.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err = tx.Exec("UPDATE live_meta SET revision=?", revision); err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE works SET title=?", strconv.Itoa(revision)); err != nil {
			return err
		}
		return tx.Commit()
	}
	if err = write(1); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		for i := 2; i <= 32; i++ {
			if err := write(i); err != nil {
				t.Error(err)
				return
			}
		}
	})
	defer wg.Wait()
	for range 40 {
		request, err := http.NewRequest("GET", host.URL+"/api/v1/works?pageSize=2", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Host = config.AllowedHosts[0]
		res, err := host.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Revision int
			Data     struct {
				Revision int
				Items    []struct{ Title string }
			}
		}
		err = json.NewDecoder(res.Body).Decode(&result)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != 200 || len(result.Data.Items) == 0 {
			t.Fatalf("snapshot response status %d", res.StatusCode)
		}
		for _, item := range result.Data.Items {
			if item.Title != strconv.Itoa(result.Revision) || result.Revision != result.Data.Revision {
				t.Fatalf("mixed HTTP envelope/page/title: %d/%d/%s", result.Revision, result.Data.Revision, item.Title)
			}
		}
	}
}
