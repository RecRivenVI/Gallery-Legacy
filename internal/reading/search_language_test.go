package reading_test

import (
	"context"
	"encoding/json"
	"net/url"
	"path/filepath"
	"sync"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"github.com/RecRivenVI/Gallery-Legacy/internal/personal"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func searchFixture(t *testing.T) (*reading.Reader, *personal.Store) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	definition, err := api.LoadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	sources := map[string]string{}
	for _, p := range definition.Platforms {
		sources[p.ID] = filepath.Join(root, "sources", p.ID)
	}
	run := filepath.Join(root, "instance")
	if err = catalog.CreateLive(ctx, run, sources); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(run, "live/catalog.sqlite")
	writer, err := catalog.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	inputs := []struct{ platform, author, name, raw string }{
		{"pixiv", "700", "one", `{"id":"90001","title":"雨 风景","caption":"hiddenbody <b>秘密</b>","date":"2026-01-01T00:00:00Z","user":{"id":"700","name":"画家"},"tags":["风景","AI","a,b"],"x_restrict":1,"type":"manga","series":{"id":"42","title":"故事"},"total_bookmarks":40}`},
		{"pixiv", "700", "two", `{"id":"90002","title":"初音 未来","date":"2026-01-02T00:00:00Z","user":{"id":"700","name":"画家"},"tags":["风景"],"x_restrict":2,"type":"manga","series":{"id":"42","title":"故事"},"total_bookmarks":100}`},
		{"pixivFANBOX", "fan", "post", `{"id":"11","title":"雨 风景","user":{"userId":"700","creatorId":"fan","name":"画家支援","profileLinks":["https://example.test/artist"]}}`},
		{"X", "x", "雨 风景", `{"tweet_id":"22","content":"雨 风景","user":{"id":"800","name":"推主","nick":"artist","url":"https://example.test/artist"}}`},
	}
	for _, input := range inputs {
		result, _ := metadata.Parse(input.platform, input.author, input.name, []byte(input.raw))
		p := catalog.Fill(input.platform, input.author, input.name, input.author+"\\"+input.name, 1790000000000000000, "valid", nil, nil, result, "", "", []catalog.File{{Relative: "1.png", Key: "1.png", Name: "1.png", Kind: "image", Extension: ".png", Size: 1, Mtime: 1790000000000000000}, {Relative: "2.png", Key: "2.png", Name: "2.png", Kind: "image", Extension: ".png", Size: 1, Mtime: 1790000000000000000}, {Relative: "cover.png", Key: "cover.png", Name: "cover.png", Kind: "image", Extension: ".png", Size: 1, Mtime: 1790000000000000000}})
		if _, err = writer.BatchWithAuthors(ctx, []catalog.PreparedWork{p}, []catalog.AuthorEnd{{Platform: input.platform, Key: input.author, Complete: true}}); err != nil {
			t.Fatal(err)
		}
	}
	// Profile-link candidates are exact stored URLs; fixture does not fetch it.
	if _, err = writer.DB.Exec("UPDATE author_profiles SET profile_url='https://example.test/artist' WHERE author_id IN(SELECT author_id FROM authors WHERE platform_id='X')"); err != nil {
		t.Fatal(err)
	}
	r, err := reading.Open(ctx, file, "query-test", true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	people, err := personal.Open(filepath.Join(root, "people"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { people.Close() })
	r.PersonalFile = people.File
	return r, people
}

func page(t *testing.T, r *reading.Reader, ctx context.Context, query string) reading.Row {
	t.Helper()
	params, err := url.ParseQuery(query)
	if err != nil {
		t.Fatal(err)
	}
	value, err := r.Snapshot(ctx, func(v *reading.View) (any, error) { return v.Page("works", params, nil) })
	if err != nil {
		t.Fatal(err)
	}
	return value.(reading.Row)
}
func TestVisibleSearchFieldsSyntaxFiltersAndCrossPlatform(t *testing.T) {
	r, _ := searchFixture(t)
	ctx := context.Background()
	cases := []struct {
		q string
		n int64
	}{
		{"q=hiddenbody", 0}, {"q=90001", 0}, {"q=正文:hiddenbody", 1}, {"q=ID:90001", 1}, {"q=作者ID:700", 3},
		{"q=雨+风景", 3}, {"q=初音+风景", 1}, {"q=雨+-标签:AI", 2}, {"q=%22初音+未来%22", 1},
		{"q=标签:风景+标签:AI", 1}, {"q=title:风景+platform:p,f", 2},
		{"includeTags=%5B%22风景%22%5D&excludeTags=%5B%22AI%22%5D", 1}, {"ratings=2", 1}, {"types=manga", 2}, {"pages=single", 0}, {"includeTags=%5B%22a%2Cb%22%5D", 1},
		{"q=title:初音&platforms=pixiv,微博", 1}, {"from=2026-01-02&to=2026-01-02", 1},
	}
	for _, c := range cases {
		t.Run(c.q, func(t *testing.T) {
			result := page(t, r, ctx, c.q)
			if result["total"] != c.n {
				t.Fatalf("wanted %d got %v", c.n, result["total"])
			}
		})
	}
	_, err := r.Snapshot(ctx, func(v *reading.View) (any, error) {
		return v.Page("works", url.Values{"platforms": {"pixiv,微博"}}, nil)
	})
	if err == nil {
		t.Fatal("unconditional all-platform browsing accepted")
	}
	sorted := page(t, r, ctx, "platform=pixiv&sort=bookmarks_desc")["items"].([]reading.Row)
	if sorted[0]["title"] != "初音 未来" {
		t.Fatalf("metric sort %v", sorted[0]["title"])
	}
}

func TestPersonalReaderIsolationAndExactAuthorLinks(t *testing.T) {
	r, s := searchFixture(t)
	ctx := context.Background()
	a, err := s.Create(ctx, "甲", "", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Create(ctx, "乙", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []api.PersonalChange{{Work: "/p/pixiv/700/one", Action: "favorite", Value: true}, {Work: "/p/pixiv/700/one", Action: "read", Number: 1}, {Work: "/p/pixiv/700/one", Action: "tag.add", Text: "私人"}} {
		if err = s.Change(ctx, a.ID, change); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id, want := a.ID, int64(1)
			if i%2 == 1 {
				id, want = b.ID, 0
			}
			value, err := r.Snapshot(reading.WithAccount(ctx, id), func(v *reading.View) (any, error) { return v.Page("works", url.Values{"my": {"continue"}}, nil) })
			if err != nil {
				t.Error(err)
				return
			}
			if value.(reading.Row)["total"] != want {
				t.Errorf("account state leaked: %v", value)
			}
		}(i)
	}
	wg.Wait()
	if result := page(t, r, reading.WithAccount(ctx, a.ID), "q=mytag:私人"); result["total"] != int64(1) {
		t.Fatal("personal tag search")
	}
	var author int64
	if err = r.DB.QueryRow("SELECT author_id FROM authors WHERE platform_id='pixiv'").Scan(&author); err != nil {
		t.Fatal(err)
	}
	value, err := r.Snapshot(ctx, func(v *reading.View) (any, error) { return v.AuthorPage(author) })
	if err != nil {
		t.Fatal(err)
	}
	data := value.(reading.Row)
	if len(data["linked"].([]reading.Row)) != 1 {
		t.Fatalf("exact links %v", data["linked"])
	}
	if err = s.Link(ctx, "/p/pixiv/700", "/p/pixivFANBOX/fan", "unlink"); err != nil {
		t.Fatal(err)
	}
	value, err = r.Snapshot(ctx, func(v *reading.View) (any, error) { return v.AuthorPage(author) })
	if err != nil {
		t.Fatal(err)
	}
	if len(value.(reading.Row)["linked"].([]reading.Row)) != 0 {
		t.Fatal("unlink did not suppress automatic key")
	}
	if err = s.Link(ctx, "/p/pixiv/700", "/p/X/x", "link"); err != nil {
		t.Fatal(err)
	}
	if result := page(t, r, ctx, "linkedAuthor=pixiv:700"); result["total"] != int64(3) {
		t.Fatalf("linked scope %v", result["total"])
	}
	var work int64
	if err = r.DB.QueryRow("SELECT work_id FROM works WHERE source_work_id='90001'").Scan(&work); err != nil {
		t.Fatal(err)
	}
	value, err = r.Snapshot(ctx, func(v *reading.View) (any, error) { return v.Episodes(work) })
	if err != nil {
		t.Fatal(err)
	}
	if value.(reading.Row)["next"].(reading.Row)["title"] != "初音 未来" {
		t.Fatal("series next episode")
	}
}

func TestReadableProgressAndIgnoredTransitiveAuthorPair(t *testing.T) {
	r, s := searchFixture(t)
	ctx := context.Background()
	a, err := s.Create(ctx, "读者", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Change(ctx, a.ID, api.PersonalChange{Work: "/p/pixiv/700/one", Action: "read", Number: 2}); err != nil {
		t.Fatal(err)
	}
	if got := page(t, r, reading.WithAccount(ctx, a.ID), "my=continue")["total"]; got != int64(0) {
		t.Fatalf("cover counted as unread page: %v", got)
	}
	items := page(t, r, ctx, "platform=pixiv")["items"].([]reading.Row)
	for _, item := range items {
		if item["counts"].(reading.Row)["media"] != int64(2) {
			t.Fatal("cover included in readable count")
		}
	}
	for _, pair := range [][3]string{{"/p/pixiv/700", "/p/X/x", "link"}, {"/p/X/x", "/p/pixivFANBOX/fan", "link"}, {"/p/pixiv/700", "/p/pixivFANBOX/fan", "ignore"}} {
		if err = s.Link(ctx, pair[0], pair[1], pair[2]); err != nil {
			t.Fatal(err)
		}
	}
	if got := page(t, r, ctx, "linkedAuthor=pixiv:700")["total"]; got != int64(3) {
		t.Fatalf("ignored pair returned through another edge: %v", got)
	}
	value, err := r.Snapshot(ctx, func(v *reading.View) (any, error) { return v.Position("/p/pixiv/700/two", 1) })
	if err != nil || value.(reading.Row)["page"] != int64(2) {
		t.Fatalf("series position %v %v", value, err)
	}
}
