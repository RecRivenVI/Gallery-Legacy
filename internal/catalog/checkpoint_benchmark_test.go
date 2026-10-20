package catalog

import (
	"context"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"sort"
	"testing"
	"time"
	"unsafe"
)

type benchmarkIO struct{ ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes uint64 }

func processBenchmarkIO(b *testing.B) benchmarkIO {
	b.Helper()
	var io benchmarkIO
	r, _, e := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetProcessIoCounters").Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&io)))
	if r == 0 {
		b.Fatal(e)
	}
	return io
}

// Isolate checkpoint cadence with equal prepared facts, batch/cache sizes,
// FULL commits and a completed final checkpoint. Neither arm uses real data.
func BenchmarkCheckpointCadence(b *testing.B) {
	works := benchmarkWorks(8192)
	for _, pages := range []int{1000, 8192} {
		b.Run(fmt.Sprint(pages), func(b *testing.B) {
			for n := 0; n < b.N; n++ {
				b.StopTimer()
				w := testWriter(b)
				if _, e := w.DB.Exec(fmt.Sprintf("PRAGMA wal_autocheckpoint=%d", pages)); e != nil {
					b.Fatal(e)
				}
				var full int
				if e := w.DB.QueryRow("PRAGMA synchronous").Scan(&full); e != nil || full != 2 {
					b.Fatal("FULL required", full, e)
				}
				var seq int
				var schema, file string
				if e := w.DB.QueryRow("PRAGMA database_list").Scan(&seq, &schema, &file); e != nil {
					b.Fatal(e)
				}
				var peak int64
				commits := []int64{}
				ctx := context.Background()
				lastCheckpoint := time.Now()
				beforeIO := processBenchmarkIO(b)
				b.StartTimer()
				started := time.Now()
				for i := 0; i < len(works); i += 128 {
					before := w.Metrics.Commit.Load()
					if _, e := w.Batch(ctx, works[i:i+128]); e != nil {
						b.Fatal(e)
					}
					commits = append(commits, w.Metrics.Commit.Load()-before)
					if st, e := os.Stat(file + "-wal"); e == nil && st.Size() > peak {
						peak = st.Size()
					}
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
				afterIO := processBenchmarkIO(b)
				b.StopTimer()
				sort.Slice(commits, func(i, j int) bool { return commits[i] < commits[j] })
				b.ReportMetric(float64(elapsed.Nanoseconds())/1e6, "durable-ms/op")
				b.ReportMetric(float64(w.Metrics.Commit.Load())/1e6, "commit-ms/op")
				b.ReportMetric(float64(w.Metrics.Checkpoint.Load())/1e6, "checkpoint-ms/op")
				b.ReportMetric(float64(commits[len(commits)*95/100])/1e6, "commit-p95-ms")
				b.ReportMetric(float64(peak), "wal-peak-bytes")
				b.ReportMetric(float64(afterIO.WriteBytes-beforeIO.WriteBytes), "logical-write-bytes")
				if e := w.Verify(ctx); e != nil {
					b.Fatal(e)
				}
				var busy, log, done int
				if e := w.DB.QueryRow("PRAGMA wal_checkpoint(PASSIVE)").Scan(&busy, &log, &done); e != nil || busy != 0 || done != log {
					b.Fatal("final checkpoint incomplete", busy, log, done, e)
				}
				w.Close()
			}
		})
	}
}
