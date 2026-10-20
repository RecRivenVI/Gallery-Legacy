// Package indexing implements the isolated acceptance scan. No product frontend
// or Node parser participates in the pipeline.
package indexing

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Counters struct{ Listings, ListingBytes, NativeChecks, DirectoryTimeDifferences, MetadataReads, MetadataBytes, Prepared, Committed, Failed, Batches, WriteNanos, PrepareNanos, QueueNanos, Added, Updated, Deleted, SpoolNanos, WriterQueueNanos, DiskWaitNanos, ReadNanos, ParseNanos, ReconcileNanos, NativeNanos, ListingLookupNanos, ListingWriteNanos, ListingTransactions, ListingRows, Preparing, PeakPreparing, MappingNanos, VolumeProbes, DirectoryReads, EnumerationNanos, ReusedMediaAttributes, DirectoryOpenNanos, DirectoryReadNanos, DirectoryMapNanos, DirectoryVerifyNanos atomic.Int64 }
type Status struct {
	Running                              bool   `json:"running"`
	State                                string `json:"state"`
	Phase                                string `json:"phase"`
	StartedAtMs, FinishedAtMs, ElapsedMs int64
	Counts                               map[string]int64 `json:"counts"`
	PlatformIds                          []string         `json:"platformIds"`
	Progress                             map[string]any   `json:"progress"`
	Failure                              string           `json:"failure,omitempty"`
}

func (s Status) MarshalJSON() ([]byte, error) {
	type alias Status
	return json.Marshal(map[string]any{"running": s.Running, "state": s.State, "phase": s.Phase, "startedAtMs": s.StartedAtMs, "finishedAtMs": s.FinishedAtMs, "elapsedMs": s.ElapsedMs, "counts": s.Counts, "changes": map[string]int64{"worksAdded": s.Counts["worksAdded"], "worksUpdated": s.Counts["worksUpdated"], "worksDeleted": s.Counts["worksDeleted"]}, "platformIds": s.PlatformIds, "progress": s.Progress, "failure": s.Failure})
}

type Budget struct {
	mu        sync.Mutex
	used, max int64
	wake      chan struct{}
}

func NewBudget(max int64) *Budget { return &Budget{max: max, wake: make(chan struct{})} }
func (b *Budget) Acquire(ctx context.Context, n int64) error {
	if n > b.max {
		return errors.New("WORK_MEMORY_BUDGET_EXCEEDED")
	}
	for {
		b.mu.Lock()
		if b.used+n <= b.max {
			b.used += n
			b.mu.Unlock()
			return nil
		}
		wake := b.wake
		b.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
func (b *Budget) Release(n int64) {
	b.mu.Lock()
	b.used -= n
	close(b.wake)
	b.wake = make(chan struct{})
	b.mu.Unlock()
}

type authorJob struct {
	platform string
	entry    library.Entry
	stage    *platformStage
}
type message struct {
	work                       *catalog.PreparedWork
	empty                      *catalog.PreparedWork
	authority                  *catalog.PreparedWork
	platform, key, fingerprint string
	complete                   bool
	bytes                      int64
}
type Pipeline struct {
	Config                    library.Config
	Mode, AuthorDirectoryName string
	reused                    atomic.Int64
	anchorReads               atomic.Int64
	Emit                      func(Status)
	c                         Counters
	started                   time.Time
	mu                        sync.Mutex
	phase                     string
	done                      []map[string]any
	platformStates            map[string]string
	active                    map[string]int
	metadataStates            map[string]int64
	failureCodes              map[string]int64
	selected                  []string
	disks                     map[string]chan struct{}
	rawBudget, queueBudget    *Budget
	prepareSlots              chan struct{}
	admissionMu               sync.Mutex
	admissionQueue            []*preparationRequest
	admissionNanos            atomic.Int64
	writerMetrics             *catalog.WriteMetrics
	preparation               map[string]*preparationMetrics
	Delay                     time.Duration
}

func (p *Pipeline) snapshot(state string, running bool, failure string) Status {
	p.mu.Lock()
	phase := p.phase
	done := append([]map[string]any{}, p.done...)
	active := []string{}
	for _, id := range p.selected {
		if p.active[id] > 0 || p.platformStates[id] == "WRITING" || p.platformStates[id] == "RECONCILING" {
			active = append(active, id)
		}
	}
	states := map[string]int64{}
	for k, v := range p.metadataStates {
		states[k] = v
	}
	codes := map[string]int64{}
	for k, v := range p.failureCodes {
		codes[k] = v
	}
	tasks := map[string]string{}
	for k, v := range p.platformStates {
		tasks[k] = v
	}
	if running {
		for _, candidate := range []string{"WRITING", "RECONCILING", "PREPARING", "LISTING", "QUEUED"} {
			found := false
			for _, task := range tasks {
				if task == candidate {
					found = true
					break
				}
			}
			if found {
				phase = candidate
				break
			}
		}
	}
	p.mu.Unlock()
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	counts := map[string]int64{"listingEntries": p.c.Listings.Load(), "listingBytes": p.c.ListingBytes.Load(), "nativeSafetyChecks": p.c.NativeChecks.Load(), "nativeDirectoryReads": 0, "metadataReads": p.c.MetadataReads.Load(), "metadataBytes": p.c.MetadataBytes.Load(), "worksPrepared": p.c.Prepared.Load(), "worksCommitted": p.c.Committed.Load(), "failures": p.c.Failed.Load(), "batches": p.c.Batches.Load(), "worksAdded": p.c.Added.Load(), "worksUpdated": p.c.Updated.Load(), "worksDeleted": p.c.Deleted.Load(), "writeMs": p.c.WriteNanos.Load() / 1000000, "prepareMs": p.c.PrepareNanos.Load() / 1000000, "queueWaitMs": p.c.QueueNanos.Load() / 1000000, "heapBytes": int64(mem.Alloc)}
	counts["platformSpoolMs"] = p.c.SpoolNanos.Load() / 1000000
	counts["worksReused"] = p.reused.Load()
	counts["authorAnchorsRead"] = p.anchorReads.Load()
	counts["writerQueueWaitMs"] = p.c.WriterQueueNanos.Load() / 1000000
	counts["diskWaitMs"] = p.c.DiskWaitNanos.Load() / 1000000
	counts["preparationAdmissionWaitMs"] = p.admissionNanos.Load() / 1000000
	counts["metadataReadMs"] = p.c.ReadNanos.Load() / 1000000
	counts["metadataParseMs"] = p.c.ParseNanos.Load() / 1000000
	counts["reconcileMs"] = p.c.ReconcileNanos.Load() / 1000000
	counts["nativeSafetyMs"] = p.c.NativeNanos.Load() / 1000000
	counts["listingLookupMs"] = p.c.ListingLookupNanos.Load() / 1000000
	counts["listingWriteMs"] = p.c.ListingWriteNanos.Load() / 1000000
	counts["listingTransactions"] = p.c.ListingTransactions.Load()
	counts["listingRows"] = p.c.ListingRows.Load()
	counts["preparationWorkers"] = p.c.Preparing.Load()
	counts["peakPreparationWorkers"] = p.c.PeakPreparing.Load()
	counts["mappingMs"] = p.c.MappingNanos.Load() / 1000000
	counts["volumeProbes"] = p.c.VolumeProbes.Load()
	counts["directoryTimeDifferences"] = p.c.DirectoryTimeDifferences.Load()
	counts["nativeDirectoryReads"] = p.c.DirectoryReads.Load()
	counts["enumerationMs"] = p.c.EnumerationNanos.Load() / 1000000
	counts["directoryOpenMs"] = p.c.DirectoryOpenNanos.Load() / 1000000
	counts["directoryReadMs"] = p.c.DirectoryReadNanos.Load() / 1000000
	counts["directoryMapMs"] = p.c.DirectoryMapNanos.Load() / 1000000
	counts["directoryVerifyMs"] = p.c.DirectoryVerifyNanos.Load() / 1000000
	counts["reusedMediaAttributes"] = p.c.ReusedMediaAttributes.Load()
	if m := p.writerMetrics; m != nil {
		counts["writeCatalogMs"] = m.Catalog.Load() / 1000000
		counts["writeSearchMs"] = m.Search.Load() / 1000000
		counts["writeCommitMs"] = m.Commit.Load() / 1000000
		counts["writeIdentityMs"] = m.Identity.Load() / 1000000
		counts["writeVerifyMs"] = m.Verify.Load() / 1000000
		counts["writeCheckpointMs"] = m.Checkpoint.Load() / 1000000
		counts["writeTransactions"] = m.Transactions.Load()
		counts["writeAllocations"] = m.Allocations.Load()
		counts["writeStatementPrepares"] = m.StatementPrepares.Load()
		counts["writeStatementCacheHits"] = m.StatementCacheHits.Load()
	}
	commitGroups := map[string]any{}
	if m := p.writerMetrics; m != nil {
		commitGroups = map[string]any{"work": m.WorkCommits.Snapshot(), "author": m.AuthorCommits.Snapshot(), "maintenance": m.MaintenanceCommits.Snapshot()}
	}
	finished := int64(0)
	if !running {
		finished = time.Now().UnixMilli()
	}
	return Status{running, state, phase, p.started.UnixMilli(), finished, time.Since(p.started).Milliseconds(), counts, p.selected, map[string]any{"phase": phase, "listingSource": p.Config.ListingSource, "checkedWorks": p.c.Prepared.Load(), "processedWorks": p.c.Committed.Load(), "platformResults": done, "selectedPlatforms": p.selected, "activePlatforms": active, "metadataStates": states, "failureCodes": codes, "platformTasks": tasks, "commitGroups": commitGroups}, failure}
}
func (p *Pipeline) Run(parent context.Context, platforms []string) error {
	if e := p.validateScope(platforms); e != nil {
		return e
	}
	p.started = time.Now()
	p.phase = "LISTING"
	p.active = map[string]int{}
	p.platformStates = map[string]string{}
	p.metadataStates = map[string]int64{}
	p.failureCodes = map[string]int64{}
	p.selected = platforms
	p.disks = map[string]chan struct{}{}
	p.rawBudget = NewBudget(64 << 20)
	p.queueBudget = NewBudget(64 << 20)
	p.prepareSlots = make(chan struct{}, p.Config.Workers)
	p.preparation = map[string]*preparationMetrics{}
	for _, id := range platforms {
		p.preparation[id] = &preparationMetrics{}
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if len(platforms) == 0 {
		return errors.New("PLATFORMS_REQUIRED")
	}
	seen := map[string]bool{}
	for _, id := range platforms {
		if _, ok := p.Config.Sources[id]; !ok || seen[id] {
			return errors.New("PLATFORM_INVALID")
		}
		seen[id] = true
	}
	p.initDisks(platforms)
	if e := os.MkdirAll(filepath.Join(p.Config.InstanceRoot, "state"), 0700); e != nil {
		return e
	}
	release, e := library.Lease(filepath.Join(p.Config.InstanceRoot, "state", "go-scan.lock"))
	if e != nil {
		return e
	}
	defer release()
	writer, e := catalog.Open(p.Config.Database)
	if e != nil {
		return e
	}
	defer writer.Close()
	p.writerMetrics = &writer.Metrics
	if e = writer.AssertBindings(ctx, p.Config.Sources); e != nil {
		return e
	}
	read, e := openRead(p.Config.Database)
	if e != nil {
		return e
	}
	defer read.Close()
	listing, e := library.NewListing(filepath.Join(p.Config.InstanceRoot, "temp"))
	if e != nil {
		return e
	}
	defer listing.Close()
	stopProgress := make(chan struct{})
	var progress sync.WaitGroup
	progress.Add(1)
	go func() {
		defer progress.Done()
		timer := time.NewTicker(500 * time.Millisecond)
		defer timer.Stop()
		for {
			select {
			case <-timer.C:
				if p.Emit != nil {
					p.Emit(p.snapshot("RUNNING", true, ""))
				}
			case <-stopProgress:
				return
			}
		}
	}()
	var stopOnce sync.Once
	stopReporting := func() { stopOnce.Do(func() { close(stopProgress); progress.Wait() }) }
	defer stopReporting()
	if p.Emit != nil {
		p.Emit(p.snapshot("RUNNING", true, ""))
	}
	jobs := make(chan authorJob, p.Config.Workers)
	ready := make(chan *platformStage, len(platforms))
	var workers, coordinators sync.WaitGroup
	setState := func(id, state string) { p.mu.Lock(); p.platformStates[id] = state; p.phase = state; p.mu.Unlock() }
	for i := 0; i < p.Config.Workers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range jobs {
				func() {
					defer job.stage.jobs.Done()
					defer func() { <-job.stage.authorSlots }()
					if ctx.Err() != nil {
						job.stage.fail(ctx.Err())
						return
					}
					p.mu.Lock()
					p.active[job.platform]++
					p.mu.Unlock()
					complete, _, e := p.author(ctx, listing, read, job, job.stage.append)
					p.mu.Lock()
					p.active[job.platform]--
					p.mu.Unlock()
					if e != nil || !complete {
						if e == nil {
							e = errors.New("FILESYSTEM_INCOMPLETE")
						} else if ctx.Err() == nil {
							p.c.Failed.Add(1)
						}
						job.stage.fail(e)
						return
					}
				}()
			}
		}()
	}
	// Limit listing traffic independently of author dispatch. A large platform
	// waiting for workers does not monopolize both root discovery slots.
	fetchSlots := make(chan struct{}, 2)
	var stages []*platformStage
	for _, id := range platforms {
		stage, e := newStage(filepath.Join(p.Config.InstanceRoot, "temp"), id)
		if e != nil {
			cancel()
			close(jobs)
			workers.Wait()
			for _, s := range stages {
				s.close()
			}
			return e
		}
		stages = append(stages, stage)
		stage.authorSlots = make(chan struct{}, authorConcurrency(p.Config.Workers, cap(p.disks[p.Config.Sources[id]])))
	}
	defer func() {
		for _, s := range stages {
			s.close()
		}
	}()
	for _, s := range stages {
		coordinators.Add(1)
		go func(s *platformStage) {
			defer coordinators.Done()
			setState(s.id, "LISTING")
			var nativeRoot library.Directory
			func() {
				select {
				case fetchSlots <- struct{}{}:
				case <-ctx.Done():
					s.fail(ctx.Err())
					return
				}
				var e error
				nativeRoot, e = p.enumerate(ctx, listing, s.id, ".")
				<-fetchSlots
				p.c.ListingRows.Store(listing.Entries.Load())
				p.c.ListingWriteNanos.Store(listing.WriteNanos.Load())
				p.c.ListingTransactions.Store(listing.Transactions.Load())
				if e != nil {
					s.fail(e)
					p.c.Failed.Add(1)
					return
				}
				setState(s.id, "PREPARING")
				after := ""
				for {
					authors, e := listing.Page(ctx, s.id, ".", after)
					if e != nil {
						s.fail(e)
						return
					}
					if len(authors) == 0 {
						break
					}
					for _, a := range authors {
						if p.AuthorDirectoryName != "" && a.Key != strings.ToLower(p.AuthorDirectoryName) {
							continue
						}
						// HDD author admission stays conservative; SSDs may use idle workers.
						select {
						case s.authorSlots <- struct{}{}:
						case <-ctx.Done():
							s.fail(ctx.Err())
							return
						}
						s.jobs.Add(1)
						select {
						case jobs <- authorJob{platform: s.id, entry: a, stage: s}:
						case <-ctx.Done():
							s.jobs.Done()
							<-s.authorSlots
							s.fail(ctx.Err())
							return
						}
					}
					after = authors[len(authors)-1].Key
				}
			}()
			s.jobs.Wait()
			if nativeRoot.Info != nil {
				if e := p.verifyDirectory(ctx, s.id, nativeRoot); e != nil {
					s.fail(e)
				}
			}
			if e := s.seal(); e != nil {
				s.fail(e)
				setState(s.id, "FAILED")
			} else {
				setState(s.id, "QUEUED")
			}
			ready <- s
		}(s)
	}
	completed := make(chan struct{})
	go func() { coordinators.Wait(); close(jobs); workers.Wait(); close(ready); close(completed) }()
	var result error
	lastCheckpoint := time.Now()
	for stage := range ready {
		stage.mu.Lock()
		stageError := stage.err
		stage.mu.Unlock()
		if stageError != nil {
			if result == nil {
				result = stageError
			}
			p.mu.Lock()
			p.done = append(p.done, map[string]any{"platformId": stage.id, "status": "FAILED", "failure": code(stageError)})
			p.mu.Unlock()
			stage.close()
			continue
		}
		if ctx.Err() != nil {
			continue
		}
		p.c.WriterQueueNanos.Add(time.Since(stage.queuedAt).Nanoseconds())
		setState(stage.id, "WRITING")
		beforeAdded, beforeUpdated, beforeDeleted := p.c.Added.Load(), p.c.Updated.Load(), p.c.Deleted.Load()
		beforeWrite, beforeCatalog, beforeSearch, beforeCommit, beforeTransactions := p.c.WriteNanos.Load(), writer.Metrics.Catalog.Load(), writer.Metrics.Search.Load(), writer.Metrics.Commit.Load(), writer.Metrics.Transactions.Load()
		batch := []catalog.PreparedWork{}
		ends := []message{}
		var batchBytes int64
		flush := func() error {
			if len(batch) > 0 || len(ends) > 0 {
				authorEnds := make([]catalog.AuthorEnd, len(ends))
				authorities := make([]catalog.PreparedWork, 0, len(ends))
				for i, m := range ends {
					authorEnds[i] = catalog.AuthorEnd{Platform: m.platform, Key: m.key, Fingerprint: m.fingerprint, Complete: m.complete}
					if m.authority != nil {
						authorities = append(authorities, *m.authority)
					}
				}
				start := time.Now()
				_, e := writer.BatchWithCompletions(ctx, batch, authorEnds, authorities)
				p.c.WriteNanos.Add(time.Since(start).Nanoseconds())
				if e != nil {
					return e
				}
				p.c.Committed.Add(int64(len(batch)))
				if len(batch) > 0 {
					p.c.Batches.Add(1)
				}
				p.c.Added.Add(writer.LastAdded)
				p.c.Updated.Add(writer.LastUpdated)
				batch = nil
				batchBytes = 0
			}
			ends = nil
			if time.Since(lastCheckpoint) > 5*time.Second {
				if e := writer.Checkpoint(ctx); e != nil {
					return e
				}
				lastCheckpoint = time.Now()
			}
			return nil
		}
		e := stage.consume(ctx, func(m message) error {
			if m.work != nil {
				batch = append(batch, *m.work)
				batchBytes += m.work.Bytes
				if len(batch) >= p.Config.BatchSize || batchBytes >= 8<<20 {
					return flush()
				}
			} else if m.empty != nil {
				start := time.Now()
				e := writer.EmptyAuthor(ctx, m.empty.Author)
				p.c.WriteNanos.Add(time.Since(start).Nanoseconds())
				return e
			} else {
				ends = append(ends, m)
				if m.authority != nil {
					batchBytes += m.authority.Bytes
				}
				if len(ends) >= 64 || batchBytes >= 8<<20 {
					return flush()
				}
			}
			return nil
		})
		if e == nil {
			e = flush()
		}
		if e == nil {
			setState(stage.id, "RECONCILING")
			var deleted int64
			start := time.Now()
			deleted, e = p.removeMissing(ctx, listing, read, writer, stage.id)
			p.c.ReconcileNanos.Add(time.Since(start).Nanoseconds())
			p.c.Deleted.Add(deleted)
		}
		if e != nil {
			if result == nil {
				result = e
			}
			cancel()
			setState(stage.id, "FAILED")
		} else {
			setState(stage.id, "COMPLETE")
			p.mu.Lock()
			p.done = append(p.done, map[string]any{"platformId": stage.id, "status": "COMPLETE", "platformChanges": map[string]int64{"worksAdded": p.c.Added.Load() - beforeAdded, "worksUpdated": p.c.Updated.Load() - beforeUpdated, "worksDeleted": p.c.Deleted.Load() - beforeDeleted}, "writeTimings": map[string]int64{"totalMs": (p.c.WriteNanos.Load() - beforeWrite) / 1000000, "catalogMs": (writer.Metrics.Catalog.Load() - beforeCatalog) / 1000000, "searchMs": (writer.Metrics.Search.Load() - beforeSearch) / 1000000, "commitMs": (writer.Metrics.Commit.Load() - beforeCommit) / 1000000, "transactions": writer.Metrics.Transactions.Load() - beforeTransactions}, "prepareTimings": p.preparation[stage.id].snapshot()})
			p.mu.Unlock()
		}
		stage.close()
		if p.Emit != nil {
			p.Emit(p.snapshot("RUNNING", true, ""))
		}
	}
	<-completed
	if parent.Err() != nil {
		result = parent.Err()
	}
	if result == nil && p.c.Failed.Load() > 0 {
		result = errors.New("FILESYSTEM_INCOMPLETE")
	}
	if result == nil {
		result = writer.Verify(ctx)
	}
	if result == nil {
		result = writer.Checkpoint(ctx)
	}
	p.c.ListingRows.Store(listing.Entries.Load())
	state, failure := "COMPLETE", ""
	p.c.ListingWriteNanos.Store(listing.WriteNanos.Load())
	p.c.ListingTransactions.Store(listing.Transactions.Load())
	if result != nil {
		state = "FAILED"
		failure = code(result)
		if errors.Is(result, context.Canceled) {
			state = "CANCELLED"
		}
	}
	p.mu.Lock()
	p.phase = state
	p.mu.Unlock()
	stopReporting()
	if p.Emit != nil {
		p.Emit(p.snapshot(state, false, failure))
	}
	return result
}

func openRead(file string) (*sql.DB, error) {
	u := url.URL{Scheme: "file", Path: "/" + strings.ReplaceAll(file, "\\", "/")}
	q := u.Query()
	q.Set("mode", "ro")
	q.Add("_pragma", "busy_timeout(1000)")
	u.RawQuery = q.Encode()
	db, e := sql.Open("sqlite", u.String())
	if e == nil {
		db.SetMaxOpenConns(8)
	}
	return db, e
}
func code(e error) string {
	if errors.Is(e, context.Canceled) {
		return "SCAN_CANCELLED"
	}
	s := e.Error()
	if len(s) < 80 && !strings.ContainsAny(s, " /\\:()\n") {
		return s
	}
	return "SCAN_FAILED"
}
func authorConcurrency(workers, diskLimit int) int { return max(1, min(workers, diskLimit)) }

// Detect each configured volume once, not once per prepared work. Roots on the
// same physical device share the most conservative detected I/O budget.
func (p *Pipeline) initDisks(platforms []string) {
	type binding struct {
		root, key string
		limit     int
	}
	bindings := []binding{}
	limits := map[string]int{}
	for _, id := range platforms {
		root := p.Config.Sources[id]
		key, limit := library.Disk(root)
		limit = preparationDeviceLimit(limit, p.Config.SlowDeviceWorkers)
		p.c.VolumeProbes.Add(1)
		bindings = append(bindings, binding{root, key, limit})
		if old, ok := limits[key]; !ok || limit < old {
			limits[key] = limit
		}
	}
	devices := map[string]chan struct{}{}
	for key, limit := range limits {
		devices[key] = make(chan struct{}, limit)
	}
	for _, b := range bindings {
		p.disks[b.root] = devices[b.key]
	}
}

// A bounded acceptance tuning budget for seek-sensitive/unknown devices.
// The global pool and shared physical-device channel still apply to all roots;
// SSD classification and every filesystem check remain unchanged.
func preparationDeviceLimit(detected, slowWorkers int) int {
	if detected == 2 && slowWorkers > 0 {
		return max(1, min(slowWorkers, 8))
	}
	return detected
}

func (p *Pipeline) disk(ctx context.Context, root string) (func(), error) {
	ch := p.disks[root]
	if ch == nil {
		return nil, errors.New("SOURCE_DISK_NOT_BOUND")
	}
	start := time.Now()
	select {
	case ch <- struct{}{}:
		p.c.DiskWaitNanos.Add(time.Since(start).Nanoseconds())
		return func() {
			p.admissionMu.Lock()
			<-ch
			p.dispatchPreparation()
			p.admissionMu.Unlock()
		}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (p *Pipeline) check(root, relative string) (os.FileInfo, error) {
	start := time.Now()
	defer func() { p.c.NativeNanos.Add(time.Since(start).Nanoseconds()) }()
	p.c.NativeChecks.Add(1)
	file, e := library.Join(root, relative)
	if e != nil {
		return nil, e
	}
	st, e := os.Lstat(file)
	if e != nil {
		return nil, e
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("PATH_REPARSE")
	}
	return st, nil
}
func (p *Pipeline) directory(root, relative string) (os.FileInfo, error) {
	start := time.Now()
	defer func() { p.c.NativeNanos.Add(time.Since(start).Nanoseconds()) }()
	p.c.NativeChecks.Add(1)
	file, e := library.Join(root, relative)
	if e != nil {
		return nil, e
	}
	return library.ObserveDirectory(file)
}

// runWorkWindow starts bounded workers, with no ordered result buffer: completed
// records go straight to the platform spool, while identity/signatures stay path-based.
func runWorkWindow(ctx context.Context, works []library.Entry, limit int, process func(library.Entry) error) error {
	jobs := make(chan library.Entry)
	var wg sync.WaitGroup
	var first error
	var mu sync.Mutex
	windowCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	for i := 0; i < min(limit, len(works)); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for work := range jobs {
				if windowCtx.Err() != nil {
					return
				}
				if e := process(work); e != nil {
					mu.Lock()
					if first == nil {
						first = e
					}
					mu.Unlock()
					cancel()
					return
				}
			}
		}()
	}
dispatch:
	for _, work := range works {
		select {
		case jobs <- work:
		case <-windowCtx.Done():
			break dispatch
		}
	}
	close(jobs)
	wg.Wait()
	if first != nil {
		return first
	}
	return ctx.Err()
}
func (p *Pipeline) author(ctx context.Context, l *library.Listing, read *sql.DB, job authorJob, out func(message) error) (bool, string, error) {
	root := p.Config.Sources[job.platform]
	nativeAuthor, e := p.enumerate(ctx, l, job.platform, job.entry.Relative)
	if e != nil {
		return false, "", e
	}
	job.entry.Mtime = nativeAuthor.Info.ModTime().UnixNano()
	after := ""
	var incomplete atomic.Bool
	worksFound := false
	var candidate catalog.PreparedWork
	var candidateEntry library.Entry
	var candidateMu sync.Mutex
	qualified := true
	for {
		at := time.Now()
		works, e := l.Page(ctx, job.platform, job.entry.Key, after)
		p.c.ListingLookupNanos.Add(time.Since(at).Nanoseconds())
		if e != nil {
			return false, "", e
		}
		if len(works) == 0 {
			break
		}
		worksFound = true
		e = runWorkWindow(ctx, works, authorConcurrency(p.Config.Workers, cap(p.disks[root])), func(work library.Entry) error {
			// A single large author can fill idle permits, but all authors combined
			// still have exactly the configured global preparation limit.
			admitStart := time.Now()
			releaseDisk, releasePreparation, e := p.admitPreparation(ctx, root)
			metrics := p.preparation[job.platform]
			if metrics != nil {
				metrics.Admission.Add(time.Since(admitStart).Nanoseconds())
			}
			if e != nil {
				return e
			}
			defer releaseDisk()
			defer releasePreparation()
			active := p.c.Preparing.Add(1)
			defer p.c.Preparing.Add(-1)
			for peak := p.c.PeakPreparing.Load(); active > peak; peak = p.c.PeakPreparing.Load() {
				if p.c.PeakPreparing.CompareAndSwap(peak, active) {
					break
				}
			}
			at := time.Now()
			prepared, e := p.prepare(ctx, l, read, job.platform, job.entry, work, releaseDisk, false)
			p.c.PrepareNanos.Add(time.Since(at).Nanoseconds())
			if metrics != nil {
				metrics.Total.Add(time.Since(at).Nanoseconds())
				metrics.Works.Add(1)
			}
			p.c.Prepared.Add(1)
			if e != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				p.c.Failed.Add(1)
				p.mu.Lock()
				p.failureCodes[code(e)]++
				p.mu.Unlock()
				incomplete.Store(true)
				return nil
			}
			p.mu.Lock()
			p.metadataStates[textState(prepared.Work["metadata_state"])]++
			p.mu.Unlock()
			candidateMu.Lock()
			qualified = qualified && prepared.Qualified
			if candidate.Key == "" || catalog.Later(prepared, candidate) {
				candidate, candidateEntry = catalog.Authority(prepared), work
			}
			candidateMu.Unlock()
			if prepared.Reused {
				p.reused.Add(1)
				return l.RecordSignature(ctx, job.platform, work.Key, prepared.Fingerprint, prepared.Work["work_dir_mtime_ns"].(int64))
			}
			at = time.Now()
			if e = p.queueBudget.Acquire(ctx, prepared.Bytes); e != nil {
				return e
			}
			p.c.QueueNanos.Add(time.Since(at).Nanoseconds())
			at = time.Now()
			e = out(message{work: &prepared, bytes: prepared.Bytes})
			p.c.SpoolNanos.Add(time.Since(at).Nanoseconds())
			p.queueBudget.Release(prepared.Bytes)
			if e != nil {
				return e
			}
			if e = l.RecordSignature(ctx, job.platform, work.Key, prepared.Fingerprint, prepared.Work["work_dir_mtime_ns"].(int64)); e != nil {
				return e
			}
			p.c.ListingWriteNanos.Store(l.WriteNanos.Load())
			p.c.ListingTransactions.Store(l.Transactions.Load())
			p.c.ListingRows.Store(l.Entries.Load())
			return nil
		})
		if e != nil {
			return false, "", e
		}
		after = works[len(works)-1].Key
	}
	if e = p.verifyDirectory(ctx, job.platform, nativeAuthor); e != nil {
		return false, "", e
	}
	at := time.Now()
	fingerprint, e := l.AuthorSignature(ctx, job.platform, job.entry.Key)
	p.c.ListingLookupNanos.Add(time.Since(at).Nanoseconds())
	if e != nil {
		return false, "", e
	}
	if incomplete.Load() {
		return false, "", nil
	}
	unchanged := false
	if p.Mode == "incremental" && qualified {
		unchanged, e = committedAuthor(ctx, read, job.platform, job.entry.Key, fingerprint)
		if e != nil {
			return false, "", e
		}
	}
	if unchanged {
		return true, fingerprint, nil
	}
	if !qualified {
		fingerprint = ""
	}
	if candidate.Reused {
		// The chosen profile anchor may be an unchanged work. Only that anchor
		// is re-read; its media/Search rows are not rewritten as a side effect.
		releaseDisk, releasePreparation, err := p.admitPreparation(ctx, root)
		if err != nil {
			return false, "", err
		}
		previous := candidate.Fingerprint
		anchorStart := time.Now()
		candidate, e = p.prepare(ctx, l, read, job.platform, job.entry, candidateEntry, releaseDisk, true)
		p.c.PrepareNanos.Add(time.Since(anchorStart).Nanoseconds())
		p.anchorReads.Add(1)
		if m := p.preparation[job.platform]; m != nil {
			m.Total.Add(time.Since(anchorStart).Nanoseconds())
		}
		releaseDisk()
		releasePreparation()
		if e != nil {
			return false, "", e
		}
		if previous != candidate.Fingerprint && !strings.HasSuffix(candidate.Fingerprint, ":"+previous) {
			return false, "", errors.New("PROFILE_ANCHOR_CHANGED")
		}
		candidate = catalog.Authority(candidate)
		if !candidate.Qualified {
			fingerprint = ""
		}
	}
	if !worksFound {
		r := metadata.New()
		r.Valid = false
		pwork := catalog.Fill(job.platform, job.entry.Name, "", job.entry.Relative, job.entry.Mtime, "missing", nil, nil, r, "", "", nil)
		pwork.Key = "" // author completion has no authority work when physically empty
		if e = out(message{empty: &pwork, platform: job.platform, key: job.entry.Key, fingerprint: fingerprint, complete: true}); e != nil {
			return false, "", e
		}
		candidate = pwork
	}
	if e = out(message{platform: job.platform, key: job.entry.Key, fingerprint: fingerprint, complete: true, authority: &candidate}); e != nil {
		return false, "", e
	}
	return !incomplete.Load(), fingerprint, nil
}
func textState(value any) string { s, _ := value.(string); return s }
func (p *Pipeline) prepare(ctx context.Context, l *library.Listing, read *sql.DB, platform string, author, work library.Entry, release func(), force bool) (catalog.PreparedWork, error) {
	var zero catalog.PreparedWork
	root := p.Config.Sources[platform]
	var entries []library.Entry
	var directories []library.Directory
	var e error
	defer release()
	if ctx.Err() != nil {
		return zero, ctx.Err()
	}
	entries, directories, e = p.nativeWork(ctx, l, platform, work)
	if e != nil {
		return zero, e
	}
	work.Mtime = directories[0].Info.ModTime().UnixNano()
	before := directories[0].Info
	fingerprint := library.Signature(entries)
	if p.Mode == "incremental" && !force {
		cached, reusable, err := committedWork(ctx, read, platform, work, fingerprint)
		if err != nil {
			return zero, err
		}
		if reusable {
			cached.Work["work_dir_mtime_ns"] = work.Mtime
			if err = p.verifyWorkDirectories(platform, directories); err != nil {
				return zero, err
			}
			return cached, nil
		}
	}
	files := []catalog.File{}
	seen := map[string]bool{}
	var raw []byte
	metaState := "missing"
	var metaMtime, metaSize any
	r := metadata.New()
	r.Valid = false
	shape := ""
	for _, entry := range entries {
		if entry.Key == work.Key {
			continue
		}
		relative := strings.TrimPrefix(entry.Relative, work.Relative+"\\")
		if relative == entry.Relative {
			return zero, errors.New("WORK_SCOPE_ESCAPE")
		}
		if entry.Kind == "folder" {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name))
		kind := mediaKind(ext)
		if strings.EqualFold(relative, "metadata.json") {
			reserved := int64(0)
			if entry.Size <= p.Config.MetadataLimit {
				reserved = entry.Size + 1
			}
			if e = p.rawBudget.Acquire(ctx, reserved); e != nil {
				return zero, e
			}
			if reserved > 0 {
				p.c.MetadataReads.Add(1)
			}
			p.c.NativeChecks.Add(1)
			path, _ := library.Join(root, entry.Relative)
			readStart := time.Now()
			var st os.FileInfo
			raw, st, e = library.ReadListedSource(root, path, p.Config.MetadataLimit, entry.Size, entry.Mtime)
			p.c.ReadNanos.Add(time.Since(readStart).Nanoseconds())
			if m := p.preparation[platform]; m != nil {
				m.Read.Add(time.Since(readStart).Nanoseconds())
			}
			p.c.MetadataBytes.Add(int64(len(raw)))
			if st != nil {
				metaMtime, metaSize = st.ModTime().UnixNano(), st.Size()
			}
			if e != nil {
				p.rawBudget.Release(reserved)
				if e.Error() == "METADATA_CHANGED_DURING_READ" || e.Error() == "METADATA_CHANGED_SINCE_LISTING" || e.Error() == "FILESYSTEM_INCOMPLETE" || strings.HasPrefix(e.Error(), "SOURCE_") || e.Error() == "PATH_REPARSE" {
					return zero, e
				}
				// An unreadable existing file only loses enrichment; a missing or
				// changed listing member still invalidates the complete work.
				if st == nil {
					st, e = p.check(root, entry.Relative)
					if e != nil || !st.Mode().IsRegular() {
						return zero, errors.New("FILESYSTEM_INCOMPLETE")
					}
					if st.Size() != entry.Size || st.ModTime().UnixNano()/100 != entry.Mtime/100 {
						return zero, errors.New("METADATA_CHANGED_SINCE_LISTING")
					}
					metaMtime, metaSize = st.ModTime().UnixNano(), st.Size()
				}
				metaState = "unreadable"
				continue
			}
			metaState = "read"
			defer p.rawBudget.Release(reserved)
			continue
		}
		if kind != "" {
			p.c.ReusedMediaAttributes.Add(1)
		}
		files = append(files, catalog.File{Relative: relative, Key: strings.ToLower(relative), Name: entry.Name, Extension: ext, Kind: kind, Size: entry.Size, Mtime: entry.Mtime})
		seen[strings.ToLower(relative)] = true
	}
	// Absence in the provider alone cannot remove a previously committed page.
	rows, e := read.QueryContext(ctx, "SELECT m.relative_path FROM media m JOIN works w USING(work_id) WHERE w.platform_id=? AND w.relative_path_key=?", platform, work.Key)
	if e != nil {
		return zero, e
	}
	for rows.Next() {
		var relative string
		if e = rows.Scan(&relative); e != nil {
			rows.Close()
			return zero, e
		}
		if !seen[strings.ToLower(relative)] {
			_, e = p.check(root, work.Relative+"\\"+relative)
			if !os.IsNotExist(e) {
				rows.Close()
				return zero, errors.New("FILESYSTEM_MISSING_EXISTING_MEDIA")
			}
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return zero, e
	}
	if metaState == "missing" {
		_, e = p.check(root, work.Relative+"\\metadata.json")
		if !os.IsNotExist(e) {
			return zero, errors.New("FILESYSTEM_MISSING_METADATA")
		}
	}
	if e = p.verifyWorkDirectories(platform, directories); e != nil {
		return zero, e
	}
	release()
	if metaState == "read" {
		parseStart := time.Now()
		var m metadata.Object
		r, m = metadata.Parse(platform, author.Name, work.Name, raw)
		if m != nil {
			metaState = "valid"
			if !r.Valid || r.InvalidFields > 0 {
				metaState = "partial"
			}
			wild := []string{}
			if platform == "微博" {
				wild = []string{"$.pic_infos"}
			}
			if platform == "pixivFANBOX" {
				wild = []string{"$.articleBody.imageMap"}
			}
			shape = metadata.Shape(platform, m, wild, nil, 1)
		} else {
			metaState = "malformed"
			if r.Reason == "metadata_not_object" {
				metaState = "non_object"
			}
		}
		p.c.ParseNanos.Add(time.Since(parseStart).Nanoseconds())
		if m := p.preparation[platform]; m != nil {
			m.Parse.Add(time.Since(parseStart).Nanoseconds())
		}
	}
	raw = nil
	if p.Delay > 0 {
		select {
		case <-time.After(p.Delay):
		case <-ctx.Done():
			return zero, ctx.Err()
		}
	}
	mappingStart := time.Now()
	prepared := catalog.Fill(platform, author.Name, work.Name, work.Relative, before.ModTime().UnixNano(), metaState, metaMtime, metaSize, r, shape, processedSignature(platform, fingerprint), files)
	prepared.Bytes = int64(len(metadata.JSON(prepared)))
	p.c.MappingNanos.Add(time.Since(mappingStart).Nanoseconds())
	if m := p.preparation[platform]; m != nil {
		m.Mapping.Add(time.Since(mappingStart).Nanoseconds())
	}
	if prepared.Bytes > 32<<20 {
		return zero, errors.New("PREPARED_WORK_TOO_LARGE")
	}
	return prepared, nil
}
func mediaKind(ext string) string {
	if strings.Contains("|avif|bmp|gif|ico|jpeg|jpg|png|svg|tif|tiff|webp|", "|"+strings.TrimPrefix(ext, ".")+"|") {
		return "image"
	}
	if strings.Contains("|avi|m4v|mkv|mov|mp4|ogv|webm|", "|"+strings.TrimPrefix(ext, ".")+"|") {
		return "video"
	}
	return ""
}

// Use the existing physical identity indexes as keyset cursors. ID-order
// pagination instead sorts the entire remaining platform for every small page.
const reconcileWorksSQL = "SELECT work_id,relative_path,relative_path_key FROM works WHERE platform_id=? AND relative_path_key>? ORDER BY relative_path_key LIMIT 256"
const reconcileAuthorsSQL = "SELECT author_id,relative_path,relative_path_key FROM authors WHERE platform_id=? AND relative_path_key>? ORDER BY relative_path_key LIMIT 256"

func (p *Pipeline) removeMissing(ctx context.Context, l *library.Listing, read *sql.DB, w *catalog.Writer, platform string) (int64, error) {
	after := ""
	deleted := int64(0)
	for {
		query, args := reconcileWorksSQL, []any{platform, after}
		if p.AuthorDirectoryName != "" {
			key := strings.ToLower(p.AuthorDirectoryName)
			query = "SELECT work_id,relative_path,relative_path_key FROM works WHERE platform_id=? AND relative_path_key>? AND relative_path_key>=? AND relative_path_key<? ORDER BY relative_path_key LIMIT 256"
			args = append(args, key+"\\", key+"]")
		}
		rows, e := read.QueryContext(ctx, query, args...)
		if e != nil {
			return deleted, e
		}
		type old struct {
			id            int64
			relative, key string
		}
		batch := []old{}
		for rows.Next() {
			var x old
			if e = rows.Scan(&x.id, &x.relative, &x.key); e != nil {
				rows.Close()
				return deleted, e
			}
			batch = append(batch, x)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return deleted, e
		}
		if len(batch) == 0 {
			break
		}
		keys := make([]string, len(batch))
		for i, x := range batch {
			keys[i] = x.key
		}
		members, e := l.Membership(ctx, platform, keys)
		if e != nil {
			return deleted, e
		}
		for _, x := range batch {
			after = x.key
			if !members[x.key] {
				_, e = p.check(p.Config.Sources[platform], x.relative)
				if !os.IsNotExist(e) {
					return deleted, errors.New("FILESYSTEM_MISSING_EXISTING_WORK")
				}
				if e = w.Remove(ctx, x.id); e != nil {
					return deleted, e
				}
				deleted++
			}
		}
	}
	// Empty physical authors are valid entities; only native-confirmed absence
	// after the complete listing can remove one.
	after = ""
	for {
		query, args := reconcileAuthorsSQL, []any{platform, after}
		if p.AuthorDirectoryName != "" {
			query = "SELECT author_id,relative_path,relative_path_key FROM authors WHERE platform_id=? AND relative_path_key>? AND relative_path_key=? ORDER BY relative_path_key LIMIT 256"
			args = append(args, strings.ToLower(p.AuthorDirectoryName))
		}
		rows, e := read.QueryContext(ctx, query, args...)
		if e != nil {
			return deleted, e
		}
		type oldAuthor struct {
			id            int64
			relative, key string
		}
		batch := []oldAuthor{}
		for rows.Next() {
			var a oldAuthor
			if e = rows.Scan(&a.id, &a.relative, &a.key); e != nil {
				rows.Close()
				return deleted, e
			}
			batch = append(batch, a)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return deleted, e
		}
		if len(batch) == 0 {
			break
		}
		keys := make([]string, len(batch))
		for i, a := range batch {
			keys[i] = a.key
		}
		members, e := l.Membership(ctx, platform, keys)
		if e != nil {
			return deleted, e
		}
		for _, a := range batch {
			after = a.key
			if !members[a.key] {
				_, e = p.check(p.Config.Sources[platform], a.relative)
				if !os.IsNotExist(e) {
					return deleted, errors.New("FILESYSTEM_MISSING_EXISTING_AUTHOR")
				}
				if e = w.RemoveAuthor(ctx, platform, a.key); e != nil {
					return deleted, e
				}
			}
		}
	}
	return deleted, nil
}
