package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

// Moving the automatic checkpoint out of COMMIT is a diagnostic control, not
// a runtime policy. Both arms keep WAL/FULL and include the final checkpoint.
func BenchmarkCommitMechanism(b *testing.B) {
	works := benchmarkWorks(4096)
	for _, automatic := range []bool{true, false} {
		b.Run(fmt.Sprint(automatic), func(b *testing.B) {
			for n := 0; n < b.N; n++ {
				b.StopTimer()
				w := testWriter(b)
				if !automatic {
					if _, e := w.DB.Exec("PRAGMA wal_autocheckpoint=0"); e != nil {
						b.Fatal(e)
					}
				}
				var full int
				if e := w.DB.QueryRow("PRAGMA synchronous").Scan(&full); e != nil || full != 2 {
					b.Fatal("FULL required", full, e)
				}
				var database string
				var seq int
				var schema string
				if e := w.DB.QueryRow("PRAGMA database_list").Scan(&seq, &schema, &database); e != nil {
					b.Fatal(e)
				}
				commits := []int64{}
				var walPeak int64
				b.StartTimer()
				start := time.Now()
				for i := 0; i < len(works); i += 128 {
					before := w.Metrics.Commit.Load()
					if _, e := w.Batch(context.Background(), works[i:i+128]); e != nil {
						b.Fatal(e)
					}
					commits = append(commits, w.Metrics.Commit.Load()-before)
					if st, e := os.Stat(database + "-wal"); e == nil && st.Size() > walPeak {
						walPeak = st.Size()
					}
				}
				if e := w.Checkpoint(context.Background()); e != nil {
					b.Fatal(e)
				}
				elapsed := time.Since(start)
				b.StopTimer()
				sort.Slice(commits, func(i, j int) bool { return commits[i] < commits[j] })
				b.ReportMetric(float64(elapsed.Nanoseconds())/1e6, "durable-ms/op")
				b.ReportMetric(float64(w.Metrics.Commit.Load())/1e6, "commit-ms/op")
				b.ReportMetric(float64(w.Metrics.Checkpoint.Load())/1e6, "checkpoint-ms/op")
				b.ReportMetric(float64(commits[len(commits)*95/100])/1e6, "commit-p95-ms")
				b.ReportMetric(float64(walPeak), "wal-peak-bytes")
				if e := w.Verify(context.Background()); e != nil {
					b.Fatal(e)
				}
				w.Close()
			}
		})
	}
}

// The same prepared synthetic facts exercise new and existing work writes.
// No enumeration or real source data participates in this writer-only probe.
func benchmarkWorks(n int) []PreparedWork {
	works := make([]PreparedWork, n)
	for i := range works {
		platform := "pixiv"
		author, name := fmt.Sprintf("synthetic-%d", i/256), fmt.Sprintf("work-%06d", i)
		raw, _ := json.Marshal(map[string]any{
			"id": fmt.Sprint(7000000 + i), "title": "合成作品 Abstract", "caption": strings.Repeat("合成 中文 abstract text &amp; ", 128),
			"tags": []string{"shared", "合成", fmt.Sprintf("group-%d", i%16)},
		})
		r, object := metadata.Parse(platform, author, name, raw)
		files := []File{}
		for page := 0; page < 4; page++ {
			filename := fmt.Sprintf("%d.png", page+1)
			files = append(files, File{Relative: filename, Key: filename, Name: filename, Extension: ".png", Kind: "image", Size: 100, Mtime: 1767225600000000000})
		}
		works[i] = Fill(platform, author, name, author+`\`+name, 1767225600000000000, "valid", 1767225600000000000, int64(len(raw)), r, metadata.Shape(platform, object, nil, nil, 1), "synthetic-signature", files)
	}
	return works
}

// Hold payload and storage policy constant; separate meaningful work commits
// from lightweight author ends instead of averaging unlike transactions.
func BenchmarkCommitMixAndBatch(b *testing.B) {
	works := benchmarkWorks(4096)
	for _, policy := range []struct {
		name   string
		size   int
		joined bool
	}{
		{"separate64", 64, false}, {"joined64", 64, true}, {"joined128", 128, true},
	} {
		b.Run(policy.name, func(b *testing.B) {
			for n := 0; n < b.N; n++ {
				b.StopTimer()
				w := testWriter(b)
				ctx := context.Background()
				var workCommit, endCommit int64
				var workTransactions, endTransactions int
				var total time.Duration
				b.StartTimer()
				at := time.Now()
				for i := 0; i < len(works); i += policy.size {
					ends := []AuthorEnd{}
					// Complete authors only after their last work, just like the spool.
					for j := i; j < i+policy.size; j++ {
						if (j+1)%256 == 0 {
							p := works[j]
							ends = append(ends, AuthorEnd{p.Platform, p.AuthorKey, "synthetic-author-signature", true})
						}
					}
					before := w.Metrics.Commit.Load()
					var e error
					if policy.joined {
						_, e = w.BatchWithAuthors(ctx, works[i:i+policy.size], ends)
					} else {
						_, e = w.Batch(ctx, works[i:i+policy.size])
					}
					if e != nil {
						b.Fatal(e)
					}
					workCommit += w.Metrics.Commit.Load() - before
					workTransactions++
					if !policy.joined {
						for _, end := range ends {
							before = w.Metrics.Commit.Load()
							if e = w.EndAuthor(ctx, end.Platform, end.Key, end.Fingerprint, true); e != nil {
								b.Fatal(e)
							}
							endCommit += w.Metrics.Commit.Load() - before
							endTransactions++
						}
					}
				}
				total += time.Since(at)
				b.StopTimer()
				b.ReportMetric(float64(total.Nanoseconds())/1e6, "write-ms/op")
				b.ReportMetric(float64(workCommit)/1e6/float64(workTransactions), "work-commit-ms/tx")
				if endTransactions > 0 {
					b.ReportMetric(float64(endCommit)/1e6/float64(endTransactions), "end-commit-ms/tx")
				}
				b.ReportMetric(float64(workCommit+endCommit)/1e6, "commit-ms/op")
				b.ReportMetric(float64(w.Metrics.Transactions.Load()), "transactions/op")
				if e := w.Verify(ctx); e != nil {
					b.Fatal(e)
				}
				var count int
				if e := w.DB.QueryRow("SELECT count(*) FROM live_scan_authors").Scan(&count); e != nil || count != 16 {
					b.Fatal("author facts lost", e, count)
				}
				w.Close()
			}
		})
	}
}

func BenchmarkDurablePlatformBatch(b *testing.B) {
	for _, platform := range []string{"pixiv", "微博"} {
		works := benchmarkWorks(8192)
		if platform == "微博" {
			for i := range works {
				author, name := fmt.Sprintf("synthetic-%d", i/256), fmt.Sprintf("work-%06d", i)
				raw, _ := json.Marshal(map[string]any{"idstr": fmt.Sprint(9000000 + i), "text": strings.Repeat("合成 中文 abstract text ", 128), "user": map[string]any{"idstr": fmt.Sprint(i / 256), "screen_name": author}, "created_at": "2026-01-01T00:00:00Z"})
				r, object := metadata.Parse(platform, author, name, raw)
				works[i] = Fill(platform, author, name, author+`\`+name, 1767225600000000000, "valid", 1767225600000000000, int64(len(raw)), r, metadata.Shape(platform, object, []string{"$.pic_infos"}, nil, 1), "synthetic-signature", []File{{Relative: "1.png", Key: "1.png", Name: "1.png", Extension: ".png", Kind: "image", Size: 100, Mtime: 1767225600000000000}})
			}
		}
		for _, size := range []int{64, 128, 256} {
			b.Run(platform+"/"+fmt.Sprint(size), func(b *testing.B) {
				for n := 0; n < b.N; n++ {
					b.StopTimer()
					w := testWriter(b)
					ctx := context.Background()
					b.StartTimer()
					for i := 0; i < len(works); i += size {
						ends := []AuthorEnd{}
						for j := i; j < i+size; j++ {
							if (j+1)%256 == 0 {
								p := works[j]
								ends = append(ends, AuthorEnd{p.Platform, p.AuthorKey, "synthetic-author-signature", true})
							}
						}
						if _, e := w.BatchWithAuthors(ctx, works[i:i+size], ends); e != nil {
							b.Fatal(e)
						}
					}
					b.StopTimer()
					b.ReportMetric(float64(w.Metrics.Transactions.Load()), "transactions/op")
					b.ReportMetric(float64(w.Metrics.Commit.Load())/1e6, "commit-ms/op")
					b.ReportMetric(float64(w.Metrics.Catalog.Load())/1e6, "catalog-ms/op")
					b.ReportMetric(float64(w.Metrics.Search.Load())/1e6, "search-ms/op")
					if e := w.Verify(ctx); e != nil {
						b.Fatal(e)
					}
					var full, checkpoint int
					if e := w.DB.QueryRow("PRAGMA synchronous").Scan(&full); e != nil || full != 2 {
						b.Fatal("FULL drift", e, full)
					}
					if e := w.DB.QueryRow("PRAGMA wal_autocheckpoint").Scan(&checkpoint); e != nil || checkpoint != automaticCheckpointPages {
						b.Fatal("checkpoint drift", e, checkpoint)
					}
					w.Close()
				}
			})
		}
	}
}

func BenchmarkWriterBatches(b *testing.B) {
	const n = 2048
	works := benchmarkWorks(n)
	for _, update := range []bool{false, true} {
		label := "new"
		if update {
			label = "update"
		}
		b.Run(label, func(b *testing.B) {
			for iteration := 0; iteration < b.N; iteration++ {
				b.StopTimer()
				w := testWriter(b)
				ctx := context.Background()
				if update {
					for i := 0; i < n; i += 64 {
						if _, err := w.Batch(ctx, works[i:i+64]); err != nil {
							b.Fatal(err)
						}
					}
				}
				w.Metrics.Catalog.Store(0)
				w.Metrics.Search.Store(0)
				w.Metrics.Commit.Store(0)
				w.Metrics.Identity.Store(0)
				b.StartTimer()
				for i := 0; i < n; i += 64 {
					if _, err := w.Batch(ctx, works[i:i+64]); err != nil {
						b.Fatal(err)
					}
				}
				b.StopTimer()
				b.ReportMetric(float64(w.Metrics.Catalog.Load())/1e6, "catalog-ms/op")
				b.ReportMetric(float64(w.Metrics.Search.Load())/1e6, "search-ms/op")
				b.ReportMetric(float64(w.Metrics.Commit.Load())/1e6, "commit-ms/op")
				b.ReportMetric(float64(w.Metrics.Identity.Load())/1e6, "identity-ms/op")
				if err := w.Verify(ctx); err != nil {
					b.Fatal(err)
				}
				w.Close()
			}
			b.ReportMetric(n, "works/op")
		})
	}
}

func BenchmarkWriterBatchSize(b *testing.B) {
	works := benchmarkWorks(4096)
	for _, size := range []int{64, 128} {
		b.Run(fmt.Sprint(size), func(b *testing.B) {
			for iteration := 0; iteration < b.N; iteration++ {
				b.StopTimer()
				w := testWriter(b)
				b.StartTimer()
				for i := 0; i < len(works); i += size {
					if _, err := w.Batch(context.Background(), works[i:i+size]); err != nil {
						b.Fatal(err)
					}
				}
				b.StopTimer()
				b.ReportMetric(float64(w.Metrics.Commit.Load())/1e6, "commit-ms/op")
				if err := w.Verify(context.Background()); err != nil {
					b.Fatal(err)
				}
				w.Close()
			}
		})
	}
}

// Probe the same bounded transactions and FULL durability on newly generated
// synthetic facts. These policies are benchmark-only, not runtime settings.
func BenchmarkWriterStoragePolicy(b *testing.B) {
	for _, platform := range []string{"pixiv", "微博"} {
		works := benchmarkWorks(8192)
		if platform == "微博" {
			for i := range works {
				author, name := fmt.Sprintf("synthetic-%d", i/256), fmt.Sprintf("work-%06d", i)
				raw, _ := json.Marshal(map[string]any{"idstr": fmt.Sprint(9000000 + i), "text": strings.Repeat("合成 中文 abstract text ", 128), "user": map[string]any{"idstr": fmt.Sprint(i / 256), "screen_name": author}, "created_at": "2026-01-01T00:00:00Z"})
				r, object := metadata.Parse(platform, author, name, raw)
				works[i] = Fill(platform, author, name, author+`\`+name, 1767225600000000000, "valid", 1767225600000000000, int64(len(raw)), r, metadata.Shape(platform, object, []string{"$.pic_infos"}, nil, 1), "synthetic-signature", []File{{Relative: "1.png", Key: "1.png", Name: "1.png", Extension: ".png", Kind: "image", Size: 100, Mtime: 1767225600000000000}})
			}
		}
		for _, policy := range []struct {
			name              string
			cache, checkpoint int
		}{{"default", -2000, 1000}, {"cache32", -32768, 1000}, {"cache32-wal8192", -32768, 8192}} {
			b.Run(platform+"/"+policy.name, func(b *testing.B) {
				for iteration := 0; iteration < b.N; iteration++ {
					b.StopTimer()
					w := testWriter(b)
					ctx := context.Background()
					if _, e := w.DB.Exec(fmt.Sprintf("PRAGMA cache_size=%d; PRAGMA wal_autocheckpoint=%d", policy.cache, policy.checkpoint)); e != nil {
						b.Fatal(e)
					}
					var durability int
					if e := w.DB.QueryRow("PRAGMA synchronous").Scan(&durability); e != nil || durability != 2 {
						b.Fatal("FULL required", e, durability)
					}
					b.StartTimer()
					for i := 0; i < len(works); i += 64 {
						if _, e := w.Batch(ctx, works[i:i+64]); e != nil {
							b.Fatal(e)
						}
					}
					b.StopTimer()
					b.ReportMetric(float64(w.Metrics.Catalog.Load())/1e6, "catalog-ms/op")
					b.ReportMetric(float64(w.Metrics.Search.Load())/1e6, "search-ms/op")
					b.ReportMetric(float64(w.Metrics.Commit.Load())/1e6, "commit-ms/op")
					b.ReportMetric(float64(w.Metrics.StatementPrepares.Load()), "prepares/op")
					b.ReportMetric(float64(w.Metrics.StatementCacheHits.Load()), "statement-reuses/op")
					if e := w.Checkpoint(ctx); e != nil {
						b.Fatal(e)
					}
					b.ReportMetric(float64(w.Metrics.Checkpoint.Load())/1e6, "checkpoint-ms/op")
					if e := w.Verify(ctx); e != nil {
						b.Fatal(e)
					}
					w.Close()
				}
			})
		}
	}
}

func BenchmarkAuthorCompletionTransactions(b *testing.B) {
	works := benchmarkWorks(1024)
	for i := range works {
		author := fmt.Sprintf("synthetic-author-%04d", i)
		p := &works[i]
		p.AuthorKey = author
		p.Key = author + `\work`
		p.Work["relative_path"] = p.Key
		p.Work["relative_path_key"] = p.Key
		p.Author["relative_path"] = author
		p.Author["relative_path_key"] = author
		p.Author["folder_name"] = author
	}
	for _, joined := range []bool{false, true} {
		b.Run(fmt.Sprint(joined), func(b *testing.B) {
			for n := 0; n < b.N; n++ {
				b.StopTimer()
				w := testWriter(b)
				ctx := context.Background()
				b.StartTimer()
				for i := 0; i < len(works); i += 64 {
					ends := make([]AuthorEnd, 64)
					for j, p := range works[i : i+64] {
						ends[j] = AuthorEnd{p.Platform, p.AuthorKey, "synthetic-author-signature", true}
					}
					if joined {
						if _, e := w.BatchWithAuthors(ctx, works[i:i+64], ends); e != nil {
							b.Fatal(e)
						}
					} else {
						if _, e := w.Batch(ctx, works[i:i+64]); e != nil {
							b.Fatal(e)
						}
						for _, end := range ends {
							if e := w.EndAuthor(ctx, end.Platform, end.Key, end.Fingerprint, end.Complete); e != nil {
								b.Fatal(e)
							}
						}
					}
				}
				b.StopTimer()
				b.ReportMetric(float64(w.Metrics.Transactions.Load()), "transactions/op")
				b.ReportMetric(float64(w.Metrics.Commit.Load())/1e6, "commit-ms/op")
				if e := w.Verify(ctx); e != nil {
					b.Fatal(e)
				}
				var count int
				if e := w.DB.QueryRow("SELECT count(*) FROM live_scan_authors").Scan(&count); e != nil || count != len(works) {
					b.Fatal("author signature mismatch", count, e)
				}
				w.Close()
			}
		})
	}
}
