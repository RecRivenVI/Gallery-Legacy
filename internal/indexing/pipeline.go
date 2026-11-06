// Package indexing implements the isolated acceptance scan. No product frontend
// or Node parser participates in the pipeline.
package indexing

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/diagnostic"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Counters struct{ Listings, ListingBytes, NativeChecks, DirectoryTimeDifferences, MetadataReads, MetadataBytes, Warnings, Prepared, Committed, Failed, Batches, WriteNanos, PrepareNanos, QueueNanos, Added, Updated, Deleted, SpoolNanos, WriterQueueNanos, DiskWaitNanos, ReadNanos, ParseNanos, ReconcileNanos, NativeNanos, ListingLookupNanos, ListingWriteNanos, ListingTransactions, ListingRows, Preparing, PeakPreparing, MappingNanos, VolumeProbes, DirectoryReads, EnumerationNanos, ReusedMediaAttributes, DirectoryOpenNanos, DirectoryReadNanos, DirectoryMapNanos, DirectoryVerifyNanos atomic.Int64 }
type Status api.ScanStatus

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

type workJob struct {
	author                          *authorSession
	work                            library.Entry
	metadata                        *metadataInput
	releaseDisk, releasePreparation func()
	started                         time.Time
}
type message struct {
	work                       *catalog.PreparedWork
	empty                      *catalog.PreparedWork
	authority                  *catalog.PreparedWork
	platform, key, fingerprint string
	complete                   bool
	bytes                      int64
	finished                   *platformStage
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
	mediaCommitted            atomic.Int64
	preparation               map[string]*preparationMetrics
	platformProgress          map[string]*platformProgress
	issues                    []map[string]string
	issueLog                  *issueLog
	Delay                     time.Duration
	Inventory                 *library.Everything
	PhysicalOrder             physicalOrder
	Device                    func(string) (string, int)
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
	platformProgress := []map[string]any{}
	for _, id := range p.selected {
		s := p.platformProgress[id]
		platformProgress = append(platformProgress, map[string]any{"platformId": id, "totalWorks": s.totalWorks, "totalAuthors": s.totalAuthors, "scannedWorks": s.works.Load() - s.skippedWorks.Load(), "skippedWorks": s.skippedWorks.Load(), "scannedAuthors": s.authors.Load() - s.skippedAuthors.Load(), "skippedAuthors": s.skippedAuthors.Load(), "failedWorks": s.failed.Load()})
	}
	issues := append([]map[string]string{}, p.issues...)
	p.mu.Unlock()
	var mem runtime.MemStats
	if diagnostic.Enabled {
		runtime.ReadMemStats(&mem)
	}
	counts := map[string]int64{"listingEntries": p.c.Listings.Load(), "listingBytes": p.c.ListingBytes.Load(), "nativeSafetyChecks": p.c.NativeChecks.Load(), "nativeDirectoryReads": 0, "metadataReads": p.c.MetadataReads.Load(), "metadataBytes": p.c.MetadataBytes.Load(), "worksPrepared": p.c.Prepared.Load(), "worksCommitted": p.c.Committed.Load(), "failures": p.c.Failed.Load(), "batches": p.c.Batches.Load(), "worksAdded": p.c.Added.Load(), "worksUpdated": p.c.Updated.Load(), "worksDeleted": p.c.Deleted.Load(), "writeMs": p.c.WriteNanos.Load() / 1000000, "prepareMs": p.c.PrepareNanos.Load() / 1000000, "queueWaitMs": p.c.QueueNanos.Load() / 1000000, "heapBytes": int64(mem.Alloc)}
	counts["warnings"] = p.c.Warnings.Load()
	counts["platformSpoolMs"] = p.c.SpoolNanos.Load() / 1000000
	counts["worksReused"] = p.reused.Load()
	counts["authorAnchorsRead"] = p.anchorReads.Load()
	counts["mediaCommitted"] = p.mediaCommitted.Load()
	counts["writerQueueWaitMs"] = p.c.WriterQueueNanos.Load() / 1000000
	counts["diskWaitMs"] = p.c.DiskWaitNanos.Load() / 1000000
	counts["preparationAdmissionWaitMs"] = p.admissionNanos.Load() / 1000000
	counts["metadataReadMs"] = p.c.ReadNanos.Load() / 1000000
	counts["metadataReadAverageUs"] = 0
	if n := p.c.MetadataReads.Load(); n > 0 {
		counts["metadataReadAverageUs"] = p.c.ReadNanos.Load() / n / 1000
	}
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
	return Status{Running: running, State: state, Phase: phase, StartedAtMs: p.started.UnixMilli(), FinishedAtMs: finished, ElapsedMs: time.Since(p.started).Milliseconds(), Counts: counts, PlatformIds: p.selected, Progress: map[string]any{"phase": phase, "listingSource": p.Config.ListingSource, "checkedWorks": p.c.Prepared.Load(), "processedWorks": p.c.Committed.Load(), "platformResults": done, "selectedPlatforms": p.selected, "activePlatforms": active, "metadataStates": states, "failureCodes": codes, "platformTasks": tasks, "commitGroups": commitGroups, "platformProgress": platformProgress, "issues": issues}, Failure: failure}
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
	p.platformProgress = map[string]*platformProgress{}
	for _, id := range platforms {
		p.preparation[id] = &preparationMetrics{}
		p.platformProgress[id] = &platformProgress{}
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
	if e := catalog.RecoverWorkStages(filepath.Join(p.Config.InstanceRoot, "temp")); e != nil {
		return e
	}
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
	p.issueLog, e = newIssueLog(p.Config.InstanceRoot)
	if e != nil {
		return e
	}
	defer p.issueLog.close()
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
	result := p.dispatch(ctx, cancel, platforms, listing, read, writer)
	result = errors.Join(result, p.issueLog.close())
	if parent.Err() != nil {
		result = errors.Join(result, parent.Err())
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
	return control.Code(e, "SCAN_FAILED")
}

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
		detect := p.Device
		if detect == nil {
			detect = library.Disk
		}
		key, limit := detect(root)
		limit = preparationDeviceLimit(limit)
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
func preparationDeviceLimit(detected int) int {
	if detected == 2 {
		return 1
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

func textState(value any) string { s, _ := value.(string); return s }

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
