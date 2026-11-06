package catalog

import (
	"context"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func inventoryRow(e library.Entry) Row {
	return Row{"key": e.Key, "relative": e.Relative, "size": e.Size, "mtime": e.Mtime}
}

func AttachInventory(ctx context.Context, tree *library.WorkTree, p *PreparedWork) error {
	if !p.Qualified {
		return nil
	}
	return tree.Each(ctx, func(e library.Entry) error {
		if e.Kind == "file" {
			p.Children["live_scan_files"] = append(p.Children["live_scan_files"], inventoryRow(e))
		}
		return nil
	})
}
