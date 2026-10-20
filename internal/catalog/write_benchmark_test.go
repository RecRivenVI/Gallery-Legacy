package catalog

import (
	"context"
	"fmt"
	"golang.org/x/sys/windows"
	"runtime"
	"sort"
	"testing"
	"time"
)

func benchmarkCPU(b *testing.B) int64 {
	b.Helper()
	var created, exited, kernel, user windows.Filetime
	if e := windows.GetProcessTimes(windows.CurrentProcess(), &created, &exited, &kernel, &user); e != nil {
		b.Fatal(e)
	}
	return int64(uint64(kernel.HighDateTime)<<32|uint64(kernel.LowDateTime)) + int64(uint64(user.HighDateTime)<<32|uint64(user.LowDateTime))
}

// The work facts, FULL durability, cache, checkpoint and batch sizes stay equal.
// Fixtures and update seeding are outside the measured interval. The completed
// final checkpoint is inside it; Verify runs afterwards without weakening it.
func BenchmarkPreparedWriter(b *testing.B) {
	for _, kind := range []string{"shared", "unique", "update"} {
		b.Run(kind, func(b *testing.B) {
			b.StopTimer()
			// Keep one scenario's fixtures alive, not three large slices captured
			// by the parent benchmark's closures. Fixtures are never measured.
			works := benchmarkWorks(8192)
			if kind == "unique" {
				for i := range works {
					works[i].Normalized.Tags = []string{fmt.Sprintf("synthetic-only-%06d", i), "合成"}
				}
			}
			for n := 0; n < b.N; n++ {
				b.StopTimer()
				w := testWriter(b)
				ctx := context.Background()
				if kind == "update" {
					for i := 0; i < len(works); i += 128 {
						if _, e := w.Batch(ctx, works[i:i+128]); e != nil {
							b.Fatal(e)
						}
					}
					if e := w.Checkpoint(ctx); e != nil {
						b.Fatal(e)
					}
				}
				catalogBefore, searchBefore, commitBefore, checkpointBefore := w.Metrics.Catalog.Load(), w.Metrics.Search.Load(), w.Metrics.Commit.Load(), w.Metrics.Checkpoint.Load()
				// Finish fixture/seeding GC before sampling the measured writer.
				runtime.GC()
				var heapBefore, heapAfter runtime.MemStats
				runtime.ReadMemStats(&heapBefore)
				ioBefore, cpuBefore := processBenchmarkIO(b), benchmarkCPU(b)
				commits := []int64{}
				lastCheckpoint := time.Now()
				b.StartTimer()
				started := time.Now()
				for i := 0; i < len(works); i += 128 {
					before := w.Metrics.Commit.Load()
					if _, e := w.Batch(ctx, works[i:i+128]); e != nil {
						b.Fatal(e)
					}
					commits = append(commits, w.Metrics.Commit.Load()-before)
					if time.Since(lastCheckpoint) >= 5*time.Second {
						if e := w.Checkpoint(ctx); e != nil {
							b.Fatal(e)
						}
						lastCheckpoint = time.Now()
					}
				}
				if e := w.Checkpoint(ctx); e != nil {
					b.Fatal(e)
				}
				elapsed := time.Since(started)
				cpuAfter, ioAfter := benchmarkCPU(b), processBenchmarkIO(b)
				b.StopTimer()
				runtime.ReadMemStats(&heapAfter)
				sort.Slice(commits, func(i, j int) bool { return commits[i] < commits[j] })
				b.ReportMetric(float64(elapsed.Nanoseconds())/1e6, "durable-ms/op")
				b.ReportMetric(float64(cpuAfter-cpuBefore)/1e4, "cpu-ms/op")
				b.ReportMetric(float64(heapBefore.HeapAlloc), "fixture-heap-bytes")
				b.ReportMetric(float64(heapAfter.NumGC-heapBefore.NumGC), "gc-cycles/op")
				b.ReportMetric(float64(heapAfter.PauseTotalNs-heapBefore.PauseTotalNs)/1e6, "gc-pause-ms/op")
				b.ReportMetric(float64(ioAfter.WriteBytes-ioBefore.WriteBytes), "logical-write-bytes")
				b.ReportMetric(float64(w.Metrics.Catalog.Load()-catalogBefore)/1e6, "catalog-ms/op")
				b.ReportMetric(float64(w.Metrics.Search.Load()-searchBefore)/1e6, "search-ms/op")
				b.ReportMetric(float64(w.Metrics.Commit.Load()-commitBefore)/1e6, "commit-ms/op")
				b.ReportMetric(float64(w.Metrics.Checkpoint.Load()-checkpointBefore)/1e6, "checkpoint-ms/op")
				b.ReportMetric(float64(commits[len(commits)*95/100])/1e6, "commit-p95-ms")
				b.ReportMetric(8192, "works/op")
				b.ReportAllocs()
				if e := w.Verify(ctx); e != nil {
					b.Fatal(e)
				}
				var full, mode int
				if e := w.DB.QueryRow("PRAGMA synchronous").Scan(&full); e != nil || full != 2 {
					b.Fatal("FULL drift", full, e)
				}
				if e := w.DB.QueryRow("PRAGMA wal_autocheckpoint").Scan(&mode); e != nil || mode != automaticCheckpointPages {
					b.Fatal("checkpoint drift", mode, e)
				}
				w.Close()
			}
		})
	}
}
