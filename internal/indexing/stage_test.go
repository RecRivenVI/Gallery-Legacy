package indexing

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"os"
	"reflect"
	"sync"
	"testing"
)

func TestPlatformSpoolSealPrecisionAndCleanup(t *testing.T) {
	s, e := newStage(t.TempDir(), "pixiv")
	if e != nil {
		t.Fatal(e)
	}
	file := s.file.Name()
	defer s.close()
	w := catalog.PreparedWork{Platform: "pixiv", Work: catalog.Row{"mtime": int64(1791567530000000123), "source_id": "123456789012345678901234567890", "null": nil, "nested": map[string]any{"n": json.Number("12345678901234567890"), "a": []any{"x", int64(5)}}}}
	if e = s.append(message{work: &w}); e != nil {
		t.Fatal(e)
	}
	if e = s.consume(context.Background(), func(message) error { t.Fatal("unsealed read"); return nil }); e == nil {
		t.Fatal("unsealed accepted")
	}
	if e = s.seal(); e != nil {
		t.Fatal(e)
	}
	if e = s.consume(context.Background(), func(m message) error {
		if !reflect.DeepEqual(m.work.Work, w.Work) {
			t.Fatalf("precision lost: %#v", m.work.Work)
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if e = s.append(message{}); e == nil {
		t.Fatal("append after seal")
	}
	s.close()
	if _, e = os.Stat(file); !os.IsNotExist(e) {
		t.Fatal("spool retained")
	}
}
func TestPlatformSpoolConcurrentFailureAndCancellation(t *testing.T) {
	s, e := newStage(t.TempDir(), "X")
	if e != nil {
		t.Fatal(e)
	}
	defer s.close()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := s.append(message{platform: "X", complete: true}); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if e = s.seal(); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if e = s.consume(ctx, func(message) error { t.Fatal("cancelled read"); return nil }); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	failed, e := newStage(t.TempDir(), "X")
	if e != nil {
		t.Fatal(e)
	}
	defer failed.close()
	failed.fail(errors.New("FILESYSTEM_INCOMPLETE"))
	if e = failed.seal(); e == nil {
		t.Fatal("failed scope sealed")
	}
}
