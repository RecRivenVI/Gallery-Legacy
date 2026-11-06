package httpservice

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestComposeEntryAndModuleResources(t *testing.T) {
	root := t.TempDir()
	for name, text := range map[string]string{"index.html": "<html><head></head><body><script src=\"ui.js\"></script></body></html>", "ui.js": "export {}", "ui.wasm": "synthetic"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{options: Options{Frontend: root}}
	for _, path := range []string{"/", "/frontend/gallery/index.html", "/frontend/manager/index.html"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		if err := s.static(w, r, path); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(w.Body.String(), `<base href="/frontend/">`) {
			t.Fatalf("entry assets are relative to the wrong directory: %s", path)
		}
	}
	if err := s.static(httptest.NewRecorder(), httptest.NewRequest("GET", "/manage", nil), "/manage"); err == nil {
		t.Fatal("removed browser manager alias still exists")
	}
	w := httptest.NewRecorder()
	if err := s.static(w, httptest.NewRequest("GET", "/frontend/ui.wasm", nil), "/frontend/ui.wasm"); err != nil {
		t.Fatal(err)
	}
	if w.Header().Get("Content-Type") != "application/wasm" {
		t.Fatal(w.Header())
	}
}
