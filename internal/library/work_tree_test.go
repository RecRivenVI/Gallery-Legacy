package library

import (
	"context"
	"fmt"
	"testing"
)

func TestWorkTreeMoreThanPreviousEntryLimitIsDiskBounded(t *testing.T) {
	ctx := context.Background()
	tree := NewWorkTree(t.TempDir())
	defer tree.Close()
	for start := 0; start < 131073; start += 256 {
		batch := make([]Entry, 0, 256)
		for i := start; i < min(start+256, 131073); i++ {
			key := fmt.Sprintf("author\\work\\%06d.png", i)
			batch = append(batch, Entry{Key: key, Relative: key, Kind: "file", Name: fmt.Sprintf("%06d.png", i), Size: 9, Mtime: 10})
		}
		if err := tree.Add(ctx, batch); err != nil {
			t.Fatal(err)
		}
		if len(tree.Entries) > 2048 {
			t.Fatal("unbounded entries retained")
		}
	}
	if tree.DB == nil {
		t.Fatal("not staged")
	}
	var count int
	if err := tree.Each(ctx, func(Entry) error { count++; return nil }); err != nil {
		t.Fatal(err)
	}
	if count != 131073 {
		t.Fatal("entry limit silently dropped files", count)
	}
}
