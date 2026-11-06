package indexing

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type platformBatch struct {
	works                                                                                     []catalog.PreparedWork
	ends                                                                                      []catalog.AuthorEnd
	authorities                                                                               []catalog.PreparedWork
	bytes                                                                                     int64
	added, updated, deleted, writeNanos, catalogNanos, searchNanos, commitNanos, transactions int64
}

func (p *Pipeline) writeMessages(ctx context.Context, cancel context.CancelFunc, listing *library.Listing, read *sql.DB, writer *catalog.Writer, queue <-chan message) (result error) {
	writeCtx := context.WithoutCancel(ctx)
	batches := map[string]*platformBatch{}
	for _, id := range p.selected {
		batches[id] = &platformBatch{}
	}
	defer func() {
		for _, b := range batches {
			p.queueBudget.Release(b.bytes)
			for _, work := range b.works {
				if err := catalog.ReleasePrepared(work); err != nil {
					result = errors.Join(result, fmt.Errorf("release prepared work: %w", err))
				}
			}
		}
	}()
	writerFailed := false
	lastCheckpoint := time.Now()
	flush := func(id string) error {
		b := batches[id]
		if len(b.works) == 0 && len(b.ends) == 0 {
			return nil
		}
		at := time.Now()
		beforeCatalog, beforeSearch, beforeCommit, beforeTx := writer.Metrics.Catalog.Load(), writer.Metrics.Search.Load(), writer.Metrics.Commit.Load(), writer.Metrics.Transactions.Load()
		_, err := writer.BatchWithCompletions(writeCtx, b.works, b.ends, b.authorities)
		elapsed := time.Since(at).Nanoseconds()
		p.c.WriteNanos.Add(elapsed)
		b.writeNanos += elapsed
		b.catalogNanos += writer.Metrics.Catalog.Load() - beforeCatalog
		b.searchNanos += writer.Metrics.Search.Load() - beforeSearch
		b.commitNanos += writer.Metrics.Commit.Load() - beforeCommit
		b.transactions += writer.Metrics.Transactions.Load() - beforeTx
		if err != nil {
			return err
		}
		p.c.Committed.Add(int64(len(b.works)))
		if len(b.works) > 0 {
			p.c.Batches.Add(1)
		}
		p.c.Added.Add(writer.LastAdded)
		p.c.Updated.Add(writer.LastUpdated)
		b.added += writer.LastAdded
		b.updated += writer.LastUpdated
		for _, work := range b.works {
			p.mediaCommitted.Add(work.Work["media_count"].(int64))
			if err := catalog.ReleasePrepared(work); err != nil {
				return err
			}
		}
		p.queueBudget.Release(b.bytes)
		b.works, b.ends, b.authorities, b.bytes = nil, nil, nil, 0
		if time.Since(lastCheckpoint) > 5*time.Second {
			if err = writer.Checkpoint(writeCtx); err != nil {
				return err
			}
			lastCheckpoint = time.Now()
		}
		return nil
	}
	fail := func(err error) {
		writerFailed = true
		if result == nil {
			result = err
		}
		cancel()
	}
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			if ctx.Err() == nil {
				for _, id := range p.selected {
					if err := flush(id); err != nil {
						fail(err)
						break
					}
				}
			}
		case m, open := <-queue:
			if !open {
				if result == nil {
					for _, id := range p.selected {
						if err := flush(id); err != nil {
							fail(err)
							break
						}
					}
				}
				return result
			}

			if writerFailed {
				p.queueBudget.Release(m.bytes)
				if m.work != nil {
					if err := catalog.ReleasePrepared(*m.work); err != nil {
						result = errors.Join(result, err)
					}
				}
				continue
			}

			b := batches[m.platform]
			if m.finished != nil {
				err := flush(m.platform)
				if err != nil {
					fail(err)
				}
				if err == nil {
					err = m.finished.failure()
				}
				if err == nil && ctx.Err() == nil {
					p.setState(m.platform, "RECONCILING")
					at := time.Now()
					b.deleted, err = p.removeMissing(ctx, listing, read, writer, m.platform)
					p.c.ReconcileNanos.Add(time.Since(at).Nanoseconds())
					p.c.Deleted.Add(b.deleted)
				}
				state := "COMPLETE"
				row := map[string]any{"platformId": m.platform}
				if err != nil {
					state = "FAILED"
					row["failure"] = code(err)
					if !errors.Is(err, context.Canceled) {
						p.addIssue(m.platform, "", "error", code(err))
					}
					if result == nil {
						result = err
					}
				}
				p.setState(m.platform, state)
				row["status"] = state
				row["platformChanges"] = map[string]int64{"worksAdded": b.added, "worksUpdated": b.updated, "worksDeleted": b.deleted}
				row["writeTimings"] = map[string]int64{"totalMs": b.writeNanos / 1e6, "catalogMs": b.catalogNanos / 1e6, "searchMs": b.searchNanos / 1e6, "commitMs": b.commitNanos / 1e6, "transactions": b.transactions}
				row["prepareTimings"] = p.preparation[m.platform].snapshot()
				p.mu.Lock()
				p.done = append(p.done, row)
				p.mu.Unlock()
				continue
			}
			b.bytes += m.bytes
			if m.work != nil {
				b.works = append(b.works, *m.work)
			} else if m.empty != nil {
				if err := writer.EmptyAuthor(writeCtx, m.empty.Author); err != nil {
					fail(err)
				}
			} else {
				b.ends = append(b.ends, catalog.AuthorEnd{Platform: m.platform, Key: m.key, Fingerprint: m.fingerprint, Complete: m.complete})
				if m.authority != nil {
					b.authorities = append(b.authorities, *m.authority)
				}
			}
			if len(b.works) >= p.Config.BatchSize || len(b.ends) >= 64 || b.bytes >= 8<<20 {
				if err := flush(m.platform); err != nil {
					fail(err)
				}
			}
		}
	}
}
