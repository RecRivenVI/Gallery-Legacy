package indexing

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWaitingDeviceDoesNotStarveReadyDevicePreparation(t *testing.T) {
	hdd, ssd := make(chan struct{}, 2), make(chan struct{}, 2)
	p := Pipeline{disks: map[string]chan struct{}{"slow": hdd, "fast": ssd}, prepareSlots: make(chan struct{}, 1)}
	hdd <- struct{}{}
	hdd <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	started := make(chan struct{}, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			started <- struct{}{}
			disk, slot, e := p.admitPreparation(ctx, "slow")
			if e == nil {
				disk()
				slot()
			}
		}()
	}
	for i := 0; i < 8; i++ {
		<-started
	}
	fastCtx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	disk, slot, e := p.admitPreparation(fastCtx, "fast")
	if e != nil {
		cancel()
		wg.Wait()
		t.Fatal("HDD waiters captured global preparation slot", e)
	}
	disk()
	disk()
	slot() // early I/O release and deferred release are idempotent
	cancel()
	wg.Wait()
	<-hdd
	<-hdd
	if len(p.prepareSlots) != 0 || len(ssd) != 0 {
		t.Fatal("permits leaked")
	}
}

func TestDeviceTuningRetainsGlobalAndSharedPhysicalLimits(t *testing.T) {
	for _, n := range []int{0, 2, 4, 8} {
		if got := preparationDeviceLimit(32, n); got != 32 {
			t.Fatal("SSD detection overridden", n, got)
		}
		expected := n
		if n == 0 {
			expected = 2
		}
		if got := preparationDeviceLimit(2, n); got != expected {
			t.Fatal("slow device limit", n, got)
		}
	}
	if preparationDeviceLimit(2, 64) != 8 {
		t.Fatal("device limit is not bounded")
	}
	device := make(chan struct{}, 4)
	p := Pipeline{disks: map[string]chan struct{}{"first-root": device, "second-root": device}, prepareSlots: make(chan struct{}, 8)}
	var disks, slots []func()
	for i := 0; i < 4; i++ {
		root := "first-root"
		if i%2 != 0 {
			root = "second-root"
		}
		d, s, e := p.admitPreparation(context.Background(), root)
		if e != nil {
			t.Fatal(e)
		}
		disks, slots = append(disks, d), append(slots, s)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, _, e := p.admitPreparation(ctx, "second-root"); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal("roots bypassed the physical-device cap", e)
	}
	if len(device) != 4 || len(p.prepareSlots) != 4 {
		t.Fatal("queued request reserved capacity")
	}
	for i := range disks {
		disks[i]()
		slots[i]()
	}
	if len(device) != 0 || len(p.prepareSlots) != 0 || len(p.admissionQueue) != 0 {
		t.Fatal("tuned budget leaked permits")
	}
}

func TestPreparationCancellationReleasesDeviceBeforeGlobalAdmission(t *testing.T) {
	disk := make(chan struct{}, 1)
	p := Pipeline{disks: map[string]chan struct{}{"source": disk}, prepareSlots: make(chan struct{}, 1)}
	p.prepareSlots <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, _, e := p.admitPreparation(ctx, "source"); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
	if len(disk) != 0 || len(p.prepareSlots) != 1 {
		t.Fatal("cancellation leaked or released another task's permit")
	}
	<-p.prepareSlots
}

func TestWaitingGlobalPreparationDoesNotReserveIdleDevice(t *testing.T) {
	p := Pipeline{disks: map[string]chan struct{}{"slow": make(chan struct{}, 1), "fast": make(chan struct{}, 1)}, prepareSlots: make(chan struct{}, 1)}
	disk, slot, e := p.admitPreparation(context.Background(), "fast")
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		d, s, err := p.admitPreparation(ctx, "slow")
		if err == nil {
			d()
			s()
		}
		done <- err
	}()
	// Let the pending task enter admission; no filesystem or disk timing is used.
	time.Sleep(20 * time.Millisecond)
	probeCtx, stop := context.WithTimeout(context.Background(), 30*time.Millisecond)
	release, probeError := p.disk(probeCtx, "slow")
	stop()
	if release != nil {
		release()
	}
	cancel()
	<-done
	disk()
	slot()
	if probeError != nil {
		t.Fatal("idle device reserved by task waiting for global slot", probeError)
	}
	if len(p.disks["slow"]) != 0 || len(p.prepareSlots) != 0 {
		t.Fatal("permit leak")
	}
}

func TestPreparationFIFOEligibleCancellationAndEarlyRelease(t *testing.T) {
	p := Pipeline{disks: map[string]chan struct{}{"slow": make(chan struct{}, 1), "fast": make(chan struct{}, 2)}, prepareSlots: make(chan struct{}, 1)}
	d, s, e := p.admitPreparation(context.Background(), "fast")
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		rd, rs, err := p.admitPreparation(ctx, "slow")
		if err == nil {
			rd()
			rs()
		}
		first <- err
	}()
	waitQueued := func(n int) {
		t.Helper()
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			p.admissionMu.Lock()
			got := len(p.admissionQueue)
			p.admissionMu.Unlock()
			if got == n {
				return
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatal("admission queue stalled")
	}
	waitQueued(1)
	second := make(chan struct{})
	go func() {
		rd, rs, err := p.admitPreparation(context.Background(), "fast")
		if err != nil {
			t.Error(err)
		} else {
			rd()
			rd()
			rs()
			rs()
		}
		close(second)
	}()
	waitQueued(2)
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	d()
	s()
	select {
	case <-second:
	case <-time.After(time.Second):
		t.Fatal("cancelled head blocked next request")
	}
	if len(p.admissionQueue) != 0 || len(p.prepareSlots) != 0 || len(p.disks["fast"]) != 0 || len(p.disks["slow"]) != 0 {
		t.Fatal("permit leak")
	}
}

func TestFullPreparationPoolCancelsMiddleWithoutLosingFIFO(t *testing.T) {
	p := Pipeline{disks: map[string]chan struct{}{"source": make(chan struct{}, 2)}, prepareSlots: make(chan struct{}, 1)}
	heldDisk, heldSlot, err := p.admitPreparation(context.Background(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer heldDisk()
	defer heldSlot()
	granted := make(chan int, 3)
	finished := make([]chan error, 3)
	proceed := make([]chan struct{}, 3)
	cancel := make([]context.CancelFunc, 3)
	waitQueue := func(n int) {
		t.Helper()
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			p.admissionMu.Lock()
			count := len(p.admissionQueue)
			p.admissionMu.Unlock()
			if count == n {
				return
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatal("queue did not reach expected length", n)
	}
	for i := range 3 {
		ctx, stop := context.WithCancel(context.Background())
		cancel[i] = stop
		defer stop()
		finished[i], proceed[i] = make(chan error, 1), make(chan struct{})
		go func(i int) {
			d, s, e := p.admitPreparation(ctx, "source")
			if e == nil {
				granted <- i
				select {
				case <-proceed[i]:
				case <-ctx.Done():
				}
				d()
				s()
			}
			finished[i] <- e
		}(i)
		waitQueue(i + 1)
	}
	cancel[1]()
	select {
	case e := <-finished[1]:
		if !errors.Is(e, context.Canceled) {
			t.Fatal("cancelled middle request", e)
		}
	case <-time.After(time.Second):
		t.Fatal("full global pool blocked cancellation")
	}
	waitQueue(2)
	if len(p.disks["source"]) != 1 || len(p.prepareSlots) != 1 {
		t.Fatal("queued requests reserved permits")
	}
	heldDisk()
	heldSlot()
	for _, expected := range []int{0, 2} {
		select {
		case got := <-granted:
			if got != expected {
				t.Fatal("eligible FIFO changed", got, expected)
			}
		case <-time.After(time.Second):
			t.Fatal("eligible request stalled")
		}
		close(proceed[expected])
		if e := <-finished[expected]; e != nil {
			t.Fatal(e)
		}
	}
	if len(p.admissionQueue) != 0 || len(p.disks["source"]) != 0 || len(p.prepareSlots) != 0 {
		t.Fatal("permit or cancelled request leaked")
	}
}

func TestPreparationGrantCancelRaceDoesNotLeak(t *testing.T) {
	for n := 0; n < 100; n++ {
		p := Pipeline{disks: map[string]chan struct{}{"source": make(chan struct{}, 1)}, prepareSlots: make(chan struct{}, 1)}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			d, s, e := p.admitPreparation(ctx, "source")
			if e == nil {
				d()
				s()
			}
			close(done)
		}()
		cancel()
		<-done
		if len(p.admissionQueue) != 0 || len(p.disks["source"]) != 0 || len(p.prepareSlots) != 0 {
			t.Fatal("grant/cancel leaked permits")
		}
	}
}

func TestBudgetBackpressureCancellation(t *testing.T) {
	b := NewBudget(10)
	ctx := context.Background()
	if e := b.Acquire(ctx, 8); e != nil {
		t.Fatal(e)
	}
	c, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
	defer cancel()
	if e := b.Acquire(c, 3); e == nil {
		t.Fatal("backpressure ignored")
	}
	b.Release(8)
	if e := b.Acquire(ctx, 10); e != nil {
		t.Fatal(e)
	}
	b.Release(10)
	if e := b.Acquire(ctx, 11); e == nil {
		t.Fatal("oversized work allowed")
	}
}

func TestReconcileUsesIdentityIndexWithoutSortOrFullScan(t *testing.T) {
	db, e := sql.Open("sqlite", ":memory:")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	for _, table := range []struct{ name, id, index string }{{"works", "work_id", "uq_works_relative_path"}, {"authors", "author_id", "uq_authors_relative_path"}} {
		_, e = db.Exec(fmt.Sprintf("CREATE TABLE %s(%s INTEGER PRIMARY KEY,platform_id TEXT,relative_path TEXT,relative_path_key TEXT,sort_at_ms INTEGER);CREATE UNIQUE INDEX %s ON %s(platform_id,relative_path_key);CREATE INDEX idx_%s_platform_sort ON %s(platform_id,sort_at_ms DESC,%s DESC)", table.name, table.id, table.index, table.name, table.name, table.name, table.id))
		if e != nil {
			t.Fatal(e)
		}
	}
	for _, query := range []string{reconcileWorksSQL, reconcileAuthorsSQL} {
		rows, e := db.Query("EXPLAIN QUERY PLAN "+query, "pixiv", "")
		if e != nil {
			t.Fatal(e)
		}
		indexed := false
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if e = rows.Scan(&id, &parent, &unused, &detail); e != nil {
				t.Fatal(e)
			}
			if strings.Contains(detail, "TEMP B-TREE") || strings.HasPrefix(detail, "SCAN ") {
				t.Fatalf("unbounded reconciliation query: %s", detail)
			}
			indexed = indexed || strings.Contains(detail, "relative_path_key>?")
		}
		if e = rows.Err(); e != nil {
			t.Fatal(e)
		}
		rows.Close()
		if !indexed {
			t.Fatal("physical identity range index not used")
		}
	}
	// ID order intentionally differs from path order; delete each returned page
	// to prove the string cursor neither skips nor repeats page-boundary records.
	for i := 799; i >= 0; i-- {
		key := fmt.Sprintf("synthetic-%04d", i)
		if _, e = db.Exec("INSERT INTO works(platform_id,relative_path,relative_path_key) VALUES ('pixiv',?,?)", key, key); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = db.Exec("INSERT INTO works(platform_id,relative_path,relative_path_key) VALUES ('X','synthetic-0001','synthetic-0001')"); e != nil {
		t.Fatal(e)
	}
	after := ""
	count := 0
	for {
		rows, e := db.Query(reconcileWorksSQL, "pixiv", after)
		if e != nil {
			t.Fatal(e)
		}
		ids := []int64{}
		previous := after
		for rows.Next() {
			var id int64
			var relative, key string
			if e = rows.Scan(&id, &relative, &key); e != nil {
				t.Fatal(e)
			}
			if key <= previous {
				t.Fatal("cursor not increasing")
			}
			previous = key
			ids = append(ids, id)
		}
		if e = rows.Err(); e != nil {
			t.Fatal(e)
		}
		rows.Close()
		if len(ids) == 0 {
			break
		}
		after = previous
		count += len(ids)
		for _, id := range ids {
			if _, e = db.Exec("DELETE FROM works WHERE work_id=?", id); e != nil {
				t.Fatal(e)
			}
		}
	}
	if count != 800 {
		t.Fatalf("visited %d works instead of 800", count)
	}
	var retained int
	if e = db.QueryRow("SELECT count(*) FROM works WHERE platform_id='X'").Scan(&retained); e != nil || retained != 1 {
		t.Fatal("cross-platform deletion", e)
	}
}

func TestPreparationConcurrencyUsesDiskClassAndRespectsSharedBudget(t *testing.T) {
	for _, c := range []struct{ workers, disk, want int }{{8, 32, 8}, {8, 2, 2}, {1, 2, 1}, {32, 32, 32}} {
		if got := authorConcurrency(c.workers, c.disk); got != c.want {
			t.Fatalf("workers=%d disk=%d concurrency=%d", c.workers, c.disk, got)
		}
	}
	shared := make(chan struct{}, 2)
	p := Pipeline{disks: map[string]chan struct{}{"first": shared, "second": shared}}
	first, e := p.disk(context.Background(), "first")
	if e != nil {
		t.Fatal(e)
	}
	defer first()
	second, e := p.disk(context.Background(), "second")
	if e != nil {
		t.Fatal(e)
	}
	defer second()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if release, e := p.disk(ctx, "second"); e == nil {
		release()
		t.Fatal("shared physical disk limit bypassed")
	}
	if release, e := p.disk(context.Background(), "unknown"); e == nil {
		release()
		t.Fatal("unbound disk accepted")
	}
}
func TestActualMediaEligibility(t *testing.T) {
	for _, ext := range []string{".png", ".gif", ".webp", ".webm", ".mp4"} {
		if library.MediaKind(ext) == "" {
			t.Fatal("eligible missing")
		}
	}
	for _, ext := range []string{".json", ".zip", ".txt", ".html"} {
		if library.MediaKind(ext) != "" {
			t.Fatal("declaration masqueraded as actual media")
		}
	}
}

func TestSingleLargeAuthorUsesBoundedWorkWindowWithoutOrderedBlocking(t *testing.T) {
	works := make([]library.Entry, 64)
	for i := range works {
		works[i].Key = fmt.Sprint(i)
	}
	var active, peak, finished atomic.Int64
	entered := make(chan struct{}, 64)
	release := make(chan struct{})
	firstStarted := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- runWorkWindow(ctx, works, 8, func(work library.Entry) error {
			if work.Key != "0" {
				select {
				case <-firstStarted:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			n := active.Add(1)
			defer active.Add(-1)
			for p := peak.Load(); n > p; p = peak.Load() {
				if peak.CompareAndSwap(p, n) {
					break
				}
			}
			if work.Key == "0" {
				close(firstStarted)
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			entered <- struct{}{}
			finished.Add(1)
			return nil
		})
	}()
	// Later works finish even while the first work is stalled.
	for i := 0; i < 20; i++ {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("ordered result blocking")
		}
	}
	close(release)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	if finished.Load() != 64 || peak.Load() < 2 || peak.Load() > 8 {
		t.Fatal("incorrect window bounds", finished.Load(), peak.Load())
	}
}

func TestWorkWindowCancellationAndFailureJoinAllWorkers(t *testing.T) {
	works := make([]library.Entry, 100)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var called atomic.Int64
	if e := runWorkWindow(ctx, works, 8, func(library.Entry) error { called.Add(1); return nil }); !errors.Is(e, context.Canceled) || called.Load() != 0 {
		t.Fatal("cancelled window ran", e)
	}
	injected := errors.New("SYNTHETIC_FAILURE")
	if e := runWorkWindow(context.Background(), works, 8, func(library.Entry) error { return injected }); !errors.Is(e, injected) {
		t.Fatal("worker failure lost", e)
	}
}

func TestNativeListingCoalescesMembershipAndNeverSpoolsMediaRows(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	author := filepath.Join(source, "author")
	os.Mkdir(author, 0700)
	for i := 0; i < 1100; i++ {
		if e := os.Mkdir(filepath.Join(author, fmt.Sprintf("work-%04d", i)), 0700); e != nil {
			t.Fatal(e)
		}
	}
	workDir := filepath.Join(author, "work-0000")
	os.Mkdir(filepath.Join(workDir, "nested"), 0700)
	os.WriteFile(filepath.Join(workDir, "1.png"), []byte("synthetic"), 0600)
	os.WriteFile(filepath.Join(workDir, "nested", "2.png"), []byte("synthetic"), 0600)
	l, e := library.NewListing(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	p := Pipeline{Config: library.Config{Sources: map[string]string{"pixiv": source}}, disks: map[string]chan struct{}{source: make(chan struct{}, 2)}}
	if _, e = p.enumerate(ctx, l, "pixiv", "."); e != nil {
		t.Fatal(e)
	}
	if _, e = p.enumerate(ctx, l, "pixiv", "author"); e != nil {
		t.Fatal(e)
	}
	if l.Entries.Load() != 1102 || l.Transactions.Load() != 5 {
		t.Fatal("membership not coalesced", l.Entries.Load(), l.Transactions.Load())
	}
	page, e := l.Page(ctx, "pixiv", "author", "")
	if e != nil {
		t.Fatal(e)
	}
	beforeRows, beforeTx := l.Entries.Load(), l.Transactions.Load()
	entries, dirs, e := p.nativeWork(ctx, l, "pixiv", page[0])
	if e != nil {
		t.Fatal(e)
	}
	if len(entries) != 4 || len(dirs) != 2 || l.Entries.Load() != beforeRows || l.Transactions.Load() != beforeTx {
		t.Fatal("work descendants duplicated in SQL")
	}
	if p.c.Listings.Load() != 1104 {
		t.Fatal("observed count lost", p.c.Listings.Load())
	}
}
