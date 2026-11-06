package indexing

import (
	"context"
	"os"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type metadataInput struct {
	entry    library.Entry
	raw      []byte
	info     os.FileInfo
	err      error
	reserved int64
	budget   *Budget
	once     sync.Once
}

func (m *metadataInput) close() {
	if m != nil {
		m.once.Do(func() {
			m.raw = nil
			if m.budget != nil {
				m.budget.Release(m.reserved)
			}
		})
	}
}

func (p *Pipeline) readMetadata(ctx context.Context, platform string, entry library.Entry) *metadataInput {
	m := &metadataInput{entry: entry, budget: p.rawBudget}
	if entry.Size <= p.Config.MetadataLimit {
		m.reserved = min(entry.Size+1, 64<<20)
	}
	if m.err = p.rawBudget.Acquire(ctx, m.reserved); m.err != nil {
		m.budget = nil
		return m
	}
	if m.reserved > 0 {
		p.c.MetadataReads.Add(1)
	}
	p.c.NativeChecks.Add(1)
	path, err := library.Join(p.Config.Sources[platform], entry.Relative)
	if err != nil {
		m.err = err
		return m
	}
	at := time.Now()
	m.raw, m.info, m.err = library.ReadListedSource(p.Config.Sources[platform], path, p.Config.MetadataLimit, entry.Size, entry.Mtime)
	elapsed := time.Since(at).Nanoseconds()
	p.c.ReadNanos.Add(elapsed)
	p.c.MetadataBytes.Add(int64(len(m.raw)))
	if metrics := p.preparation[platform]; metrics != nil {
		metrics.Read.Add(elapsed)
	}
	return m
}
