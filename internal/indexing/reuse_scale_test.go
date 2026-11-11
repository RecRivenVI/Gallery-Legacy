package indexing

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

func TestFileFactReuseAtScale(t *testing.T) {
	base := os.Getenv("GALLERY_REUSE_SCALE_ROOT")
	if base == "" {
		t.Skip("requires a dedicated SSD scratch directory")
	}
	root, err := os.MkdirTemp(base, "reuse-scale-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("owned fixture %s", root)
	ctx := context.Background()
	listing, err := library.NewListing(root)
	if err != nil {
		t.Fatal(err)
	}
	defer listing.Close()
	file := filepath.Join(root, "catalog.sqlite")
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	synthetic := os.Getenv("GALLERY_REUSE_SCALE_WORKS")
	count, err := strconv.Atoi(synthetic)
	if err != nil || count < 100 {
		t.Fatal("set a valid GALLERY_REUSE_SCALE_WORKS")
	}
	signature := processedSignature("pixiv", "file-list-v1")
	version := metadata.Versions["pixiv"]
	data, err := catalog.EncodeAuthority(catalog.PreparedWork{Platform: "pixiv", Key: "author\\work", Work: catalog.Row{"metadata_state": "valid"}, Qualified: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE works(work_id INTEGER PRIMARY KEY,platform_id TEXT,relative_path_key TEXT,relative_path TEXT,adapter_version INTEGER,filesystem_state TEXT,filesystem_files_state TEXT,metadata_state TEXT,UNIQUE(platform_id,relative_path_key));
CREATE TABLE live_scan_works(platform_id TEXT,relative_path_key TEXT,fingerprint TEXT,adapter_version INTEGER,authority_at_ms INTEGER,authority_source_id TEXT,PRIMARY KEY(platform_id,relative_path_key)) WITHOUT ROWID;
CREATE TABLE live_scan_work_profiles(platform_id TEXT,relative_path_key TEXT,projection BLOB,PRIMARY KEY(platform_id,relative_path_key)) WITHOUT ROWID;
CREATE TABLE live_scan_files(work_id INTEGER,key TEXT,relative TEXT,size INTEGER,mtime INTEGER,PRIMARY KEY(work_id,key)) WITHOUT ROWID;`)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = db.Exec(`WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
INSERT INTO works SELECT x,'pixiv','author'||char(92)||printf('%07d',x),'author'||char(92)||printf('%07d',x),?,'present','complete','valid' FROM n;`, count, version)
	if err != nil {
		t.Fatal(err)
	}
	for _, seed := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO live_scan_works SELECT platform_id,relative_path_key,?,adapter_version,1,'' FROM works", []any{signature}},
		{"INSERT INTO live_scan_work_profiles SELECT platform_id,relative_path_key,? FROM works", []any{data}},
		{"INSERT INTO live_scan_files SELECT work_id,relative_path_key||char(92)||part,relative_path_key||char(92)||part,1024,100 FROM works CROSS JOIN (SELECT '1.png' part UNION ALL SELECT 'metadata.json' UNION ALL SELECT '2.png')", nil},
	} {
		if _, err = db.Exec(seed.query, seed.args...); err != nil {
			t.Fatal(err)
		}
	}
	_, err = listing.DB.Exec(`WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?), dirs AS (SELECT 'author'||char(92)||printf('%07d',x) path FROM n)
INSERT INTO entries SELECT 'pixiv',path,path,'author','folder',0,100,'author',path,path FROM dirs;
INSERT INTO entries SELECT 'pixiv',e.key||char(92)||part,e.relative||char(92)||part,e.key,'file',1024,100,e.author,e.key,part FROM entries e CROSS JOIN (SELECT '1.png' part UNION ALL SELECT 'metadata.json' UNION ALL SELECT '2.png') WHERE e.kind='folder';`, count)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("seed works=%d rows=%d wall=%s", count, count*4, time.Since(start))
	reuse, err := openReuse(ctx, file, listing)
	if err != nil {
		t.Fatal(err)
	}
	defer reuse.Close()
	page := func(from, to int) []library.ScheduledWork {
		items := make([]library.ScheduledWork, 0, to-from+1)
		for n := from; n <= to; n++ {
			key := fmt.Sprintf("author\\%07d", n)
			items = append(items, library.ScheduledWork{Work: library.Entry{Key: key, Relative: key}})
		}
		return items
	}
	batched := func(total, want int) time.Duration {
		t.Helper()
		begin := time.Now()
		var got int
		for from := 1; from <= total; from += 64 {
			matches, err := reusablePage(ctx, reuse, "pixiv", page(from, min(total, from+63)))
			if err != nil {
				t.Fatal(err)
			}
			got += len(matches)
		}
		if got != want {
			t.Fatalf("matched %d; expected %d", got, want)
		}
		return time.Since(begin)
	}
	control := min(10000, count)
	start = time.Now()
	for _, item := range page(1, control) {
		w := item.Work
		same, err := sameFiles(ctx, db, "pixiv", w.Key, func(accept func(library.Entry) error) error {
			rows, err := listing.DB.QueryContext(ctx, "SELECT key,relative,size,mtime FROM entries WHERE platform='pixiv' AND key>? AND key<? AND kind='file' ORDER BY key", w.Key+"\\", w.Key+"]")
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				e := library.Entry{Kind: "file"}
				if err = rows.Scan(&e.Key, &e.Relative, &e.Size, &e.Mtime); err != nil {
					return err
				}
				if err = accept(e); err != nil {
					return err
				}
			}
			return rows.Err()
		})
		if err != nil || !same {
			t.Fatal("prior check", same, err)
		}
		if _, ok, err := committedWork(ctx, db, "pixiv", w, "file-list-v1"); err != nil || !ok {
			t.Fatal("prior qualification", ok, err)
		}
	}
	old := time.Since(start)
	new := batched(control, control)
	full := batched(count, count)
	if _, err = listing.DB.Exec("UPDATE entries SET mtime=200 WHERE key='author'||char(92)||'0000001'||char(92)||'1.png'"); err != nil {
		t.Fatal(err)
	}
	changed := batched(count, count-1)
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	t.Logf("per-work=%s batched=%s on %d; unchanged=%s one-change=%s on %d; heapSysMiB=%.2f", old, new, control, full, changed, count, float64(memory.HeapSys)/(1<<20))
}
