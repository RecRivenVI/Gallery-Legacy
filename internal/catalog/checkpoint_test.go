package catalog

import (
	"context"
	"database/sql"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func writerDatabase(t *testing.T, w *Writer) string {
	t.Helper()
	var seq int
	var name, file string
	if e := w.DB.QueryRow("PRAGMA database_list").Scan(&seq, &name, &file); e != nil {
		t.Fatal(e)
	}
	return file
}

func TestCheckpointPreservesPinnedReaderAndDurableCommits(t *testing.T) {
	w := testWriter(t)
	reader, e := sql.Open("sqlite", "file:/"+strings.ReplaceAll(writerDatabase(t, w), "\\", "/")+"?mode=ro")
	if e != nil {
		t.Fatal(e)
	}
	defer reader.Close()
	tx, e := reader.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	var count int
	if e = tx.QueryRow("SELECT count(*) FROM works").Scan(&count); e != nil || count != 0 {
		t.Fatal(count, e)
	}
	ctx := context.Background()
	if _, e = w.Batch(ctx, benchmarkWorks(128)); e != nil {
		t.Fatal(e)
	}
	if e = w.Checkpoint(ctx); e != nil {
		t.Fatal(e)
	}
	var busy, log, done int
	if e = w.DB.QueryRow("PRAGMA wal_checkpoint(PASSIVE)").Scan(&busy, &log, &done); e != nil || log <= done {
		t.Fatal("reader protection lost", busy, log, done, e)
	}
	if e = tx.QueryRow("SELECT count(*) FROM works").Scan(&count); e != nil || count != 0 {
		t.Fatal("snapshot changed", count, e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	if e = w.DB.QueryRow("PRAGMA wal_checkpoint(PASSIVE)").Scan(&busy, &log, &done); e != nil || busy != 0 || done != log {
		t.Fatal("checkpoint did not catch up", busy, log, done, e)
	}
	if e = reader.QueryRow("SELECT count(*) FROM works").Scan(&count); e != nil || count != 128 {
		t.Fatal("confirmed commit lost", count, e)
	}
	if e = w.Verify(ctx); e != nil {
		t.Fatal(e)
	}
	w.DB.SetMaxIdleConns(0) // Force a fresh connection, including its DSN policy.
	var full, cadence int
	if e = w.DB.QueryRow("PRAGMA synchronous").Scan(&full); e != nil || full != 2 {
		t.Fatal(full, e)
	}
	if e = w.DB.QueryRow("PRAGMA wal_autocheckpoint").Scan(&cadence); e != nil || cadence != automaticCheckpointPages {
		t.Fatal(cadence, e)
	}
}

// Exit after a FULL commit but before any explicit checkpoint or clean close.
// Recovery must retain Catalog, Search and signatures as one atomic unit.
func TestFullCommitRecoversBeforeDeferredCheckpoint(t *testing.T) {
	if file := os.Getenv("GALLERY_SYNTHETIC_CRASH_DB"); file != "" {
		w, e := Open(file)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = w.Batch(context.Background(), benchmarkWorks(128)); e != nil {
			t.Fatal(e)
		}
		os.Exit(88)
	}
	w := testWriter(t)
	file := writerDatabase(t, w)
	if e := w.Close(); e != nil {
		t.Fatal(e)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestFullCommitRecoversBeforeDeferredCheckpoint$")
	child.Env = append(os.Environ(), "GALLERY_SYNTHETIC_CRASH_DB="+file)
	e := child.Run()
	if exit, ok := e.(*exec.ExitError); !ok || exit.ExitCode() != 88 {
		t.Fatal("synthetic crash not reached", e)
	}
	w, e = Open(file)
	if e != nil {
		t.Fatal(e)
	}
	defer w.Close()
	var count int
	if e = w.DB.QueryRow("SELECT count(*) FROM works").Scan(&count); e != nil || count != 128 {
		t.Fatal("durable commit lost", count, e)
	}
	if e = w.Verify(context.Background()); e != nil {
		t.Fatal(e)
	}
	var mismatches int
	if e = w.DB.QueryRow("SELECT count(*) FROM works w LEFT JOIN live_scan_works s ON s.platform_id=w.platform_id AND s.relative_path_key=w.relative_path_key WHERE s.platform_id IS NULL").Scan(&mismatches); e != nil || mismatches != 0 {
		t.Fatal("signature transaction split", mismatches, e)
	}
}
