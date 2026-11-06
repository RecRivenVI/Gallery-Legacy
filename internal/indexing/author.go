package indexing

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

type authorSession struct {
	p          *Pipeline
	l          *library.Listing
	read       *sql.DB
	stage      *platformStage
	entry      library.Entry
	directory  library.Directory
	remaining  atomic.Int64
	reused     atomic.Int64
	works      int64
	slots      chan struct{}
	mu         sync.Mutex
	candidate  catalog.PreparedWork
	qualified  bool
	incomplete bool
}

func (p *Pipeline) newAuthor(ctx context.Context, l *library.Listing, read *sql.DB, stage *platformStage, entry library.Entry) (*authorSession, error) {
	d, err := p.enumerate(ctx, l, stage.id, entry.Relative)
	if err != nil {
		return nil, err
	}
	entry.Mtime = d.Info.ModTime().UnixNano()
	n, err := l.AuthorWorkCount(ctx, stage.id, entry.Key)
	if err != nil {
		return nil, err
	}
	a := &authorSession{p: p, l: l, read: read, stage: stage, entry: entry, directory: d, qualified: true, works: n}
	var files int64
	if err = l.DB.QueryRowContext(ctx, "SELECT count(*) FROM entries WHERE platform=? AND key>? AND key<? AND kind='file'", stage.id, entry.Key+`\`, entry.Key+`]`).Scan(&files); err != nil {
		return nil, err
	}
	if !l.Indexed(stage.id) {
		files = n * 64
	}
	limit := max(1, min(p.Config.Workers, 8, int(n), int((files+63)/64)))

	a.slots = make(chan struct{}, limit)
	a.remaining.Store(n)
	return a, nil
}

func (a *authorSession) accept(ctx context.Context, work library.Entry, prepared catalog.PreparedWork) error {
	p := a.p
	p.mu.Lock()
	p.metadataStates[textState(prepared.Work["metadata_state"])]++
	p.mu.Unlock()
	a.mu.Lock()
	a.qualified = a.qualified && prepared.Qualified
	if a.candidate.Key == "" || catalog.Later(prepared, a.candidate) {
		a.candidate = catalog.Authority(prepared)
	}
	a.mu.Unlock()
	if prepared.Reused {
		p.reused.Add(1)
		a.reused.Add(1)
	} else {
		at := time.Now()
		err := a.stage.append(message{work: &prepared, bytes: prepared.Bytes})
		p.c.QueueNanos.Add(time.Since(at).Nanoseconds())
		if err != nil {
			return errors.Join(err, catalog.ReleasePrepared(prepared))
		}
	}
	return nil
}

func (a *authorSession) finish(ctx context.Context) error {
	p := a.p
	a.mu.Lock()
	candidate, qualified, incomplete := a.candidate, a.qualified, a.incomplete
	a.mu.Unlock()
	if incomplete {
		return nil
	}
	if err := p.verifyDirectory(ctx, a.stage.id, a.directory); err != nil {
		return err
	}
	if a.stage.id != "Venera" {
		p.platformProgress[a.stage.id].authors.Add(1)
		if a.works > 0 && a.reused.Load() == a.works {
			p.platformProgress[a.stage.id].skippedAuthors.Add(1)
		}
	}
	fingerprint := "file-list-v1"
	var err error
	if !qualified {
		fingerprint = ""
	}

	if a.works == 0 {
		r := metadata.New()
		r.Valid = false
		candidate = catalog.Fill(a.stage.id, a.entry.Name, "", a.entry.Relative, a.entry.Mtime, "missing", nil, nil, r, "", "", nil)
		candidate.Key = ""
		if err = a.stage.append(message{empty: &candidate, key: a.entry.Key, fingerprint: fingerprint, complete: true}); err != nil {
			return err
		}
	}
	return a.stage.append(message{key: a.entry.Key, fingerprint: fingerprint, complete: true, authority: &candidate})
}
