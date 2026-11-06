package indexing

import (
	"context"
	"database/sql"
	"errors"

	"strings"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func (p *Pipeline) setState(id, state string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.platformStates[id], p.phase = state, state
}

func (p *Pipeline) dispatch(ctx context.Context, cancel context.CancelFunc, platforms []string, l *library.Listing, read *sql.DB, writer *catalog.Writer) error {
	if err := l.PrepareScheduleTables(ctx); err != nil {
		return err
	}
	jobs := make(chan workJob, p.Config.Workers)
	queue := make(chan message, p.Config.Workers*2)
	var workers, coordinators sync.WaitGroup
	for i := 0; i < p.Config.Workers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range jobs {
				p.runWork(ctx, l, read, job)
			}
		}()
	}
	groups := map[chan struct{}][]string{}
	ordered, err := p.collectInventories(ctx, l, platforms)
	if err != nil {
		p.addIssue("", "", "error", code(err))
		close(jobs)
		workers.Wait()
		close(queue)
		return err
	}
	for _, id := range ordered {
		disk := p.disks[p.Config.Sources[id]]
		groups[disk] = append(groups[disk], id)
	}
	orderedQueue := make(chan message, cap(queue))
	deliveryResult := make(chan error, 1)
	go func() {
		err := p.orderMessages(ctx, l, queue, orderedQueue)
		if err != nil {
			cancel()
			for m := range queue {
				p.queueBudget.Release(m.bytes)
				if m.work != nil {
					catalog.ReleasePrepared(*m.work)
				}
			}
		}
		deliveryResult <- err
		close(orderedQueue)
	}()
	for _, ids := range groups {
		coordinators.Add(1)
		go func() {
			defer coordinators.Done()
			for _, id := range ids {
				if ctx.Err() != nil {
					return
				}
				stage := &platformStage{id: id, ctx: ctx, output: queue, budget: p.queueBudget}
				p.coordinate(ctx, l, read, stage, jobs, nil)
				queue <- message{platform: id, finished: stage}
			}
		}()
	}

	go func() { coordinators.Wait(); close(jobs); workers.Wait(); close(queue) }()
	writeErr := p.writeMessages(ctx, cancel, l, read, writer, orderedQueue)
	return errors.Join(writeErr, <-deliveryResult)
}

func (p *Pipeline) runWork(ctx context.Context, l *library.Listing, read *sql.DB, job workJob) {
	a := job.author
	defer a.stage.jobs.Done()
	defer job.releaseDisk()
	defer job.releasePreparation()
	defer func() { <-a.slots }()
	defer job.metadata.close()
	defer p.c.Preparing.Add(-1)
	if ctx.Err() != nil {
		a.stage.fail(ctx.Err())
		return
	}
	p.mu.Lock()
	p.active[a.stage.id]++
	p.mu.Unlock()
	prepared, err := p.prepare(ctx, l, read, a.stage.id, a.entry, job.work, job.releaseDisk, job.metadata)
	elapsed := time.Since(job.started).Nanoseconds()
	p.c.PrepareNanos.Add(elapsed)
	p.c.Prepared.Add(1)
	if m := p.preparation[a.stage.id]; m != nil {
		m.Total.Add(elapsed)
		m.Works.Add(1)
	}
	if err == nil {
		state := textState(prepared.Work["metadata_state"])
		if state != "valid" && state != "missing" {
			p.addIssue(a.stage.id, job.work.Relative, "warning", "METADATA_"+strings.ToUpper(state))
		}
		err = a.accept(ctx, job.work, prepared)
	}
	if err != nil {
		a.mu.Lock()
		a.incomplete = true
		a.mu.Unlock()
		a.stage.fail(err)
		if ctx.Err() == nil {
			p.c.Failed.Add(1)
			p.mu.Lock()
			p.failureCodes[code(err)]++
			p.mu.Unlock()
			p.addIssue(a.stage.id, job.work.Relative, "error", code(err))
		}
	}
	p.completeWork(a.stage.id, prepared.Reused, err)
	if a.remaining.Add(-1) == 0 && ctx.Err() == nil {
		a.stage.ends <- a
	}
	p.mu.Lock()
	p.active[a.stage.id]--
	p.mu.Unlock()
}

func (p *Pipeline) coordinate(ctx context.Context, l *library.Listing, read *sql.DB, s *platformStage, jobs chan<- workJob, slots chan struct{}) {
	p.setState(s.id, "LISTING")
	var root library.Directory
	var endDone chan struct{}
	func() {
		var err error
		root, err = p.enumerate(ctx, l, s.id, ".")
		if err != nil {
			s.fail(err)
			return
		}

		authors, err := p.discoverAuthors(ctx, l, read, s)
		if err != nil {
			s.fail(err)
			return
		}
		s.ends = make(chan *authorSession, len(authors))
		endDone = make(chan struct{})
		go func() {
			defer close(endDone)
			for a := range s.ends {
				if err := a.finish(ctx); err != nil {
					s.fail(err)
				}
			}
		}()
		if cap(p.disks[p.Config.Sources[s.id]]) == 1 {
			if err = p.loadPhysical(ctx, l, s.id); err != nil {
				s.fail(err)
				return
			}
		}
		if err = l.BuildSchedule(ctx, s.id, p.AuthorDirectoryName, cap(p.disks[p.Config.Sources[s.id]]) == 1); err != nil {
			s.fail(err)
			return
		}
		p.setState(s.id, "PREPARING")
		for after := int64(0); ; {
			works, next, err := l.ScheduledPage(ctx, s.id, after)
			if err != nil {
				s.fail(err)
				return
			}
			if len(works) == 0 {
				break
			}
			after = next
			for _, work := range works {
				if err = p.scheduleWork(ctx, s, authors[work.Work.Parent], work, jobs); err != nil {
					s.fail(err)
					return
				}
			}
		}
	}()
	s.jobs.Wait()
	if s.ends != nil {
		close(s.ends)
		<-endDone
	}
	if root.Info != nil {
		if err := p.verifyDirectory(ctx, s.id, root); err != nil {
			s.fail(err)
		}
	}
}

func (p *Pipeline) discoverAuthors(ctx context.Context, l *library.Listing, read *sql.DB, s *platformStage) (map[string]*authorSession, error) {
	authors := map[string]*authorSession{}
	for after := ""; ; {
		entries, err := l.Page(ctx, s.id, ".", after)
		if err != nil {
			return nil, err
		}
		if len(entries) == 0 {
			return authors, nil
		}
		for _, entry := range entries {
			if p.AuthorDirectoryName != "" && entry.Key != strings.ToLower(p.AuthorDirectoryName) {
				continue
			}
			a, err := p.newAuthor(ctx, l, read, s, entry)
			if err != nil {
				return nil, err
			}
			authors[entry.Key] = a
			if a.works == 0 {
				if err = a.finish(ctx); err != nil {
					return nil, err
				}
			}
		}
		after = entries[len(entries)-1].Key
	}
}

func (p *Pipeline) scheduleWork(ctx context.Context, s *platformStage, author *authorSession, work library.ScheduledWork, jobs chan<- workJob) error {
	select {
	case author.slots <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	at := time.Now()
	disk, slot, err := p.admitPreparation(ctx, p.Config.Sources[s.id])
	if m := p.preparation[s.id]; m != nil {
		m.Admission.Add(time.Since(at).Nanoseconds())
	}
	if err != nil {
		<-author.slots
		return err
	}
	active := p.c.Preparing.Add(1)
	for peak := p.c.PeakPreparing.Load(); active > peak; peak = p.c.PeakPreparing.Load() {
		if p.c.PeakPreparing.CompareAndSwap(peak, active) {
			break
		}
	}
	job := workJob{author: author, work: work.Work, releaseDisk: disk, releasePreparation: slot, started: time.Now()}
	if p.Mode == "full" && work.Metadata != nil && cap(p.disks[p.Config.Sources[s.id]]) == 1 {
		job.metadata = p.readMetadata(ctx, s.id, *work.Metadata)
	}
	s.jobs.Add(1)
	select {
	case jobs <- job:
		return nil
	case <-ctx.Done():
		s.jobs.Done()
		<-author.slots
		disk()
		slot()
		job.metadata.close()
		p.c.Preparing.Add(-1)
		return ctx.Err()
	}
}
