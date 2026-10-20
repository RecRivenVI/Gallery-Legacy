package indexing

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"strings"
)

// Independent extraction/cache contract; Catalog v4 and public protocol stay unchanged.
const extractionContract = "go1-c4-search5-shape1-policy1-map1-media1"
const initialContract = "go1-c4-search5-shape1-policy1-map1-media1"

func processedSignature(platform, raw string) string {
	return fmt.Sprintf("%s-a%d:%s", extractionContract, metadata.Versions[platform], raw)
}

func (p *Pipeline) validateScope(platforms []string) error {
	if p.Mode == "" {
		p.Mode = "full"
	}
	if p.Mode != "full" && p.Mode != "incremental" {
		return errors.New("SCAN_MODE_INVALID")
	}
	if p.AuthorDirectoryName == "" {
		return nil
	}
	if len(platforms) != 1 || strings.ContainsAny(p.AuthorDirectoryName, "\\/:\x00") || p.AuthorDirectoryName == "." || p.AuthorDirectoryName == ".." {
		return errors.New("AUTHOR_SCOPE_INVALID")
	}
	return nil
}

// Only the transactionally committed ledger qualifies reuse. An older Go full
// scan stored the identical raw signature: bridge that one known contract only.
// Future contract changes invalidate both old-prefixed and raw signatures.
func committedWork(ctx context.Context, read *sql.DB, platform string, work library.Entry, raw string) (catalog.PreparedWork, bool, error) {
	var fingerprint, state, relative string
	var adapter, workAdapter int
	var at int64
	var sourceID string
	e := read.QueryRowContext(ctx, `SELECT s.fingerprint,s.adapter_version,s.authority_at_ms,s.authority_source_id,w.metadata_state,w.adapter_version,w.relative_path
	 FROM live_scan_works s JOIN works w ON w.platform_id=s.platform_id AND w.relative_path_key=s.relative_path_key
	 WHERE s.platform_id=? AND s.relative_path_key=? AND w.filesystem_files_state='complete' AND w.filesystem_state='present'`, platform, work.Key).
		Scan(&fingerprint, &adapter, &at, &sourceID, &state, &workAdapter, &relative)
	if e == sql.ErrNoRows {
		return catalog.PreparedWork{}, false, nil
	}
	if e != nil {
		return catalog.PreparedWork{}, false, e
	}
	compatible := fingerprint == processedSignature(platform, raw) || extractionContract == initialContract && fingerprint == raw
	if !compatible || adapter != metadata.Versions[platform] || workAdapter != adapter || relative != work.Relative || state == "unreadable" {
		return catalog.PreparedWork{}, false, nil
	}
	return catalog.PreparedWork{Platform: platform, AuthorKey: strings.Split(work.Key, "\\")[0], Key: work.Key, Fingerprint: fingerprint, Work: catalog.Row{"metadata_state": state}, Qualified: true, Reused: true, AuthorityTime: at, AuthorityID: sourceID, AuthorityName: work.Name}, true, nil
}

func committedAuthor(ctx context.Context, read *sql.DB, platform, key, fingerprint string) (bool, error) {
	var previous string
	e := read.QueryRowContext(ctx, "SELECT fingerprint FROM live_scan_authors WHERE platform_id=? AND relative_path_key=?", platform, key).Scan(&previous)
	if e == sql.ErrNoRows {
		return false, nil
	}
	return previous == fingerprint, e
}
