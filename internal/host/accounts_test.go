package host

import (
	"context"
	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/personal"
	"path/filepath"
	"testing"
)

func TestManageAccountResetAndDeleteWithoutService(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	def, err := api.LoadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	sources := Row{}
	for _, p := range def.Platforms {
		sources[p.ID] = filepath.Join(root, "sources", p.ID)
	}
	c, err := instance.Normalize(Row{"instanceRoot": filepath.Join(root, "instance"), "sources": sources, "port": float64(18499)})
	if err != nil {
		t.Fatal(err)
	}
	s, err := personal.Open(filepath.Join(c.StateRoot, "people"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := s.Create(ctx, "合成读者", "before", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Manage(ctx, c, Options{}, "accounts.reset", Row{"id": a.ID, "password": "after"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Login(ctx, a.ID, "before"); err == nil {
		t.Fatal("old password accepted")
	}
	if _, err = s.Login(ctx, a.ID, "after"); err != nil {
		t.Fatal(err)
	}
	if _, err = Manage(ctx, c, Options{}, "accounts.delete", Row{"id": a.ID}); err != nil {
		t.Fatal(err)
	}
	accounts, err := s.Accounts(ctx)
	if err != nil || len(accounts) != 0 {
		t.Fatal("delete not reflected", err)
	}
}
