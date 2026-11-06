package physical

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func coverSelection(ctx context.Context, instance, index string, roots map[string]string) (map[string]bool, error) {
	if !library.Inside(instance, index) || filepath.Base(index) != "thumbs.db" {
		return nil, fmt.Errorf("NTFS_ORDER_SCOPE_INVALID")
	}
	if err := library.NoLinks(index); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(index)}
	u.RawQuery = "mode=ro"
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, "SELECT platform,relative FROM cover_jobs WHERE state='pending'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	selected := map[string]bool{}
	for rows.Next() {
		var platform, relative string
		if err = rows.Scan(&platform, &relative); err != nil {
			return nil, err
		}
		if root, ok := roots[platform]; ok {
			if _, err = library.Join(root, relative); err != nil {
				return nil, err
			}
			selected[platform+"\x00"+strings.ToLower(strings.ReplaceAll(relative, "/", `\`))] = true
		}
	}
	return selected, rows.Err()
}
