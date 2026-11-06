package instance

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStateSnapshotDoesNotBlockAtomicReplacement(t *testing.T) {
	root := os.Getenv("GALLERY_CONTROL_ROOT")
	if root == "" {
		t.Skip("explicit synthetic GALLERY_CONTROL_ROOT required")
	}
	dir, err := os.MkdirTemp(root, "StateSnapshot-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := RemoveOwned(dir); err != nil {
			t.Error(err)
		}
	})
	file := filepath.Join(dir, "state.json")
	if err = WriteJSON(file, map[string]int{"version": 1}); err != nil {
		t.Fatal(err)
	}
	f, err := openSnapshot(file)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err = WriteJSON(file, map[string]int{"version": 2}); err != nil {
		t.Fatalf("an active status reader blocked the writer: %v", err)
	}
	old, err := io.ReadAll(f)
	if err != nil || strings.TrimSpace(string(old)) != `{"version":1}` {
		t.Fatalf("opened snapshot changed: %s %v", old, err)
	}
	current, err := ReadSnapshot(file)
	if err != nil || strings.TrimSpace(string(current)) != `{"version":2}` {
		t.Fatalf("replacement unavailable: %s %v", current, err)
	}
}
