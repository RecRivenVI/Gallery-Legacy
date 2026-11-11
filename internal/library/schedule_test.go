package library

import (
	"context"
	"slices"
	"testing"
)

func TestSSDScheduleOrdersWorksByAuthorFolderCount(t *testing.T) {
	ctx := context.Background()
	entries := []Entry{
		{Platform: "pixiv", Parent: "a", Key: `a\1`, Work: `a\1`, Kind: "folder"},
		{Platform: "pixiv", Parent: "a", Key: `a\2`, Work: `a\2`, Kind: "folder"},
		{Platform: "pixiv", Parent: "b", Key: `b\1`, Work: `b\1`, Kind: "folder"},
		{Platform: "pixiv", Parent: "b", Key: `b\extra`, Kind: "folder"},
		{Platform: "pixiv", Parent: "z", Key: `z\1`, Work: `z\1`, Kind: "folder"},
		{Platform: "pixiv", Parent: "z", Key: `z\cover.jpg`, Kind: "file"},
		{Platform: "pixivFANBOX", Parent: "z", Key: `z\1`, Work: `z\1`, Kind: "folder"},
	}
	for _, test := range []struct {
		author string
		want   []string
	}{
		{"", []string{`z\1`, `a\1`, `a\2`, `b\1`}},
		{"B", []string{`b\1`}},
	} {
		t.Run("author="+test.author, func(t *testing.T) {
			listing, err := NewListing(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer listing.Close()
			if err = listing.PrepareScheduleTables(ctx); err != nil {
				t.Fatal(err)
			}
			if err = listing.PutNative(ctx, entries); err != nil {
				t.Fatal(err)
			}
			if err = listing.BuildSchedule(ctx, "pixiv", test.author, false); err != nil {
				t.Fatal(err)
			}
			rows, _, err := listing.ScheduledPage(ctx, "pixiv", 0)
			if err != nil {
				t.Fatal(err)
			}
			var keys []string
			for _, row := range rows {
				keys = append(keys, row.Work.Key)
			}
			if !slices.Equal(keys, test.want) {
				t.Fatalf("scheduled %v, want %v", keys, test.want)
			}
		})
	}
}
