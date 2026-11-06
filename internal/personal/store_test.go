package personal

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/api"
)

func TestAccountIsolationCollectionsHistoryAndSession(t *testing.T) {
	ctx := context.Background()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := s.Create(ctx, "甲", "password", json.RawMessage(`{"theme":"dark","history":true}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Create(ctx, "乙", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Login(ctx, a.ID, "wrong"); err == nil {
		t.Fatal("incorrect password accepted")
	}
	token, err := s.Login(ctx, a.ID, "password")
	if err != nil {
		t.Fatal(err)
	}
	logged, err := s.Session(ctx, token)
	if err != nil || logged == nil || logged.ID != a.ID {
		t.Fatalf("session %#v %v", logged, err)
	}
	id, err := s.Collection(ctx, a.ID, "", "收藏夹", "")
	if err != nil {
		t.Fatal(err)
	}
	path := "/p/pixiv/author/work"
	for _, c := range []api.PersonalChange{{Work: path, Action: "collections", Values: []string{id}}, {Work: path, Action: "rating", Number: 4}, {Work: path, Action: "read", Number: 2}, {Work: path, Action: "tag.add", Text: "ＡＩ"}} {
		if err = s.Change(ctx, a.ID, c); err != nil {
			t.Fatal(err)
		}
	}
	counts, err := s.Counts(ctx, a.ID)
	if err != nil || counts["favorites"] != 1 || counts["history"] != 1 {
		t.Fatalf("counts %v %v", counts, err)
	}
	tags, err := s.Tags(ctx, a.ID)
	if err != nil || len(tags) != 1 {
		t.Fatalf("tags %v %v", tags, err)
	}
	collections, err := s.Collections(ctx, a.ID)
	if err != nil || len(collections) != 1 || collections[0].Count != 1 {
		t.Fatalf("collections %v %v", collections, err)
	}
	counts, err = s.Counts(ctx, b.ID)
	if err != nil || counts["favorites"] != 0 {
		t.Fatal("account data leaked")
	}
	if err = s.Change(ctx, b.ID, api.PersonalChange{Work: path, Action: "collections", Values: []string{id}}); err == nil {
		t.Fatal("foreign collection accepted")
	}
	collections, err = s.Collections(ctx, a.ID)
	if err != nil || collections[0].Count != 1 {
		t.Fatal("foreign collection changed")
	}
	if err = s.SavePreferences(ctx, a.ID, json.RawMessage(`{"history":false}`)); err != nil {
		t.Fatal(err)
	}
	if err = s.Change(ctx, a.ID, api.PersonalChange{Work: path, Action: "read", Number: 3}); err != nil {
		t.Fatal(err)
	}
	var page int
	if err = s.DB.QueryRow("SELECT page FROM work_state WHERE account_id=?", a.ID).Scan(&page); err != nil || page != 2 {
		t.Fatalf("disabled history page %d %v", page, err)
	}
	if err = s.Change(ctx, a.ID, api.PersonalChange{Work: path, Action: "favorite", Value: false}); err != nil {
		t.Fatal(err)
	}
	collections, err = s.Collections(ctx, a.ID)
	if err != nil || collections[0].Count != 0 {
		t.Fatal("unfavorite retained collection")
	}
	if err = s.Delete(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	logged, err = s.Session(ctx, token)
	if err != nil || logged != nil {
		t.Fatal("deleted account session survived")
	}
	var mode string
	var sync int
	if err = s.DB.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if err = s.DB.QueryRow("PRAGMA synchronous").Scan(&sync); err != nil || mode != "wal" || sync != 2 {
		t.Fatal("personal persistence policy weakened")
	}
}
