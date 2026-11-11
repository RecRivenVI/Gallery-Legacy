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
const extractionContract = "go1-c4-search5-shape1-policy1-map1-media1-profile2"

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
	if len(platforms) == 1 && platforms[0] == "Venera" {
		return errors.New("AUTHOR_SCOPE_UNSUPPORTED")
	}
	if len(platforms) != 1 || strings.ContainsAny(p.AuthorDirectoryName, "\\/:\x00") || p.AuthorDirectoryName == "." || p.AuthorDirectoryName == ".." {
		return errors.New("AUTHOR_SCOPE_INVALID")
	}
	return nil
}

// Only a committed ledger and its matching profile projection qualify reuse.
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
	compatible := fingerprint == processedSignature(platform, raw)
	if !compatible || adapter != metadata.Versions[platform] || workAdapter != adapter || relative != work.Relative || state == "unreadable" {
		return catalog.PreparedWork{}, false, nil
	}
	var blob []byte
	if e = read.QueryRowContext(ctx, "SELECT projection FROM live_scan_work_profiles WHERE platform_id=? AND relative_path_key=?", platform, work.Key).Scan(&blob); e == sql.ErrNoRows {
		return catalog.PreparedWork{}, false, nil
	} else if e != nil {
		return catalog.PreparedWork{}, false, e
	}
	cached, e := catalog.DecodeAuthority(blob)
	if e != nil {
		return catalog.PreparedWork{}, false, e
	}
	cached.Reused, cached.Fingerprint = true, fingerprint
	return cached, true, nil
}

func committedAuthor(ctx context.Context, read *sql.DB, platform, key, fingerprint string) (bool, error) {
	var previous string
	e := read.QueryRowContext(ctx, "SELECT fingerprint FROM live_scan_authors WHERE platform_id=? AND relative_path_key=?", platform, key).Scan(&previous)
	if e == sql.ErrNoRows {
		return false, nil
	}
	return previous == fingerprint, e
}

func openReuse(ctx context.Context, catalogPath string, listing *library.Listing) (*sql.DB, error) {
	db, err := openRead(catalogPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(ctx, "ATTACH DATABASE ? AS listing", listing.ReadOnlyURI()); err != nil {
		db.Close()
		return nil, fmt.Errorf("open indexed reuse: %w", err)
	}
	return db, nil
}

type reuseMatch struct {
	rank  catalog.PreparedWork
	state string
}

func reusablePage(ctx context.Context, db *sql.DB, platform string, page []library.ScheduledWork) (map[string]reuseMatch, error) {
	args := []any{platform, processedSignature(platform, "file-list-v1"), metadata.Versions[platform]}
	keys := make([]string, len(page))
	for i, work := range page {
		keys[i] = "?"
		args = append(args, work.Work.Key)
	}
	rows, err := db.QueryContext(ctx, `
SELECT e.key,e.name,w.metadata_state,s.authority_at_ms,s.authority_source_id
FROM listing.entries e
JOIN live_scan_works s ON s.platform_id=e.platform AND s.relative_path_key=e.key
JOIN live_scan_work_profiles p ON p.platform_id=s.platform_id AND p.relative_path_key=s.relative_path_key
JOIN works w ON w.platform_id=e.platform AND w.relative_path_key=e.key
WHERE e.platform=? AND s.fingerprint=? AND s.adapter_version=? AND e.key IN (`+strings.Join(keys, ",")+`)
AND w.relative_path=e.relative AND w.adapter_version=s.adapter_version
AND w.filesystem_state='present' AND w.filesystem_files_state='complete'
AND w.metadata_state IN ('valid','missing','partial')
AND NOT EXISTS(
 SELECT 1 FROM live_scan_files f LEFT JOIN listing.entries x ON x.platform=e.platform AND x.key=f.key
 WHERE f.work_id=w.work_id AND (x.kind IS NOT 'file' OR x.relative<>f.relative OR x.size<>f.size OR x.mtime/100<>f.mtime/100)
)
AND NOT EXISTS(
 SELECT 1 FROM listing.entries x LEFT JOIN live_scan_files f ON f.work_id=w.work_id AND f.key=x.key
 WHERE x.platform=e.platform AND x.key>e.key||char(92) AND x.key<e.key||']' AND x.kind='file' AND f.key IS NULL
)`, args...)
	if err != nil {
		return nil, fmt.Errorf("compare committed file facts: %w", err)
	}
	defer rows.Close()
	result := map[string]reuseMatch{}
	for rows.Next() {
		match := reuseMatch{rank: catalog.PreparedWork{Platform: platform}}
		rank := &match.rank
		if err = rows.Scan(&rank.Key, &rank.AuthorityName, &match.state, &rank.AuthorityTime, &rank.AuthorityID); err != nil {
			return nil, err
		}
		result[rank.Key] = match
	}
	return result, rows.Err()
}

func reuseProjection(ctx context.Context, read *sql.DB, rank catalog.PreparedWork) (catalog.PreparedWork, error) {
	var payload []byte
	if err := read.QueryRowContext(ctx, "SELECT projection FROM live_scan_work_profiles WHERE platform_id=? AND relative_path_key=?", rank.Platform, rank.Key).Scan(&payload); err != nil {
		return catalog.PreparedWork{}, fmt.Errorf("read committed author projection: %w", err)
	}
	return catalog.DecodeAuthority(payload)
}
