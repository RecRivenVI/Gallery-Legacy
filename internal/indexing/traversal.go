package indexing

import (
	"context"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"time"
)

// Root/author membership discovery and work preparation share the same
// physical-device I/O permits. Membership is written to the existing private
// listing index; no complete platform tree is retained in memory.
func (p *Pipeline) enumerate(ctx context.Context, l *library.Listing, platform, relative string) (library.Directory, error) {
	if d, ok := l.Observation(platform, relative); ok {
		return d, nil
	}
	release, e := p.disk(ctx, p.Config.Sources[platform])
	if e != nil {
		return library.Directory{}, e
	}
	defer release()
	return p.enumerateHeld(ctx, l, platform, relative, nil)
}

// Iterative directory discovery stores large frontiers and observations in
// the work stage rather than bounding valid source depth or entry count.
func (p *Pipeline) nativeWork(ctx context.Context, l *library.Listing, platform string, work library.Entry) (*library.WorkTree, error) {
	tree := library.NewWorkTree(p.Config.InstanceRoot + "/temp")
	if err := tree.Add(ctx, []library.Entry{work}); err != nil {
		return nil, err
	}
	for {
		dir, more, err := tree.NextDirectory(ctx)
		if err != nil {
			tree.Close()
			return nil, err
		}
		if !more {
			return tree, nil
		}
		d, err := p.enumerateHeld(ctx, l, platform, dir.Relative, func(batch []library.Entry) error { return tree.Add(ctx, batch) })
		if err == nil {
			err = tree.MarkDirectory(ctx, d)
		}
		if err != nil {
			tree.Close()
			return nil, err
		}
	}
}

func (p *Pipeline) enumerateHeld(ctx context.Context, l *library.Listing, platform, relative string, accept func([]library.Entry) error) (library.Directory, error) {
	start := time.Now()
	var writeNanos int64
	pending := make([]library.Entry, 0, 1024)
	flush := func() error {
		at := time.Now()
		e := l.PutNative(ctx, pending)
		writeNanos += time.Since(at).Nanoseconds()
		pending = pending[:0]
		return e
	}
	p.c.DirectoryReads.Add(1)
	var costs library.DirectoryCosts
	d, e := library.ReadDirectoryMeasured(ctx, platform, p.Config.Sources[platform], relative, func(batch []library.Entry) error {
		p.c.Listings.Add(int64(len(batch)))
		if accept != nil {
			return accept(batch)
		}
		pending = append(pending, batch...)
		if len(pending) >= 1024 {
			return flush()
		}
		return nil
	}, &costs)
	elapsed := time.Since(start).Nanoseconds() - writeNanos
	p.c.EnumerationNanos.Add(elapsed)
	p.c.DirectoryOpenNanos.Add(costs.Open.Nanoseconds())
	p.c.DirectoryReadNanos.Add(costs.Read.Nanoseconds())
	p.c.DirectoryMapNanos.Add(costs.Map.Nanoseconds())
	p.c.DirectoryVerifyNanos.Add(costs.Verify.Nanoseconds())
	if m := p.preparation[platform]; m != nil {
		m.Enumeration.Add(elapsed)
		m.DirectoryOpen.Add(costs.Open.Nanoseconds())
		m.DirectoryRead.Add(costs.Read.Nanoseconds())
		m.DirectoryMap.Add(costs.Map.Nanoseconds())
		m.DirectoryVerify.Add(costs.Verify.Nanoseconds())
	}
	if e == nil && accept == nil {
		if e = flush(); e == nil {
			e = l.RefreshDirectory(ctx, platform, relative, d)
			if e == nil {
				l.RememberDirectory(platform, relative, d)
			}
		}
	}
	return d, e
}

func (p *Pipeline) verifyDirectory(ctx context.Context, platform string, d library.Directory) error {
	release, e := p.disk(ctx, p.Config.Sources[platform])
	if e != nil {
		return e
	}
	defer release()
	p.c.NativeChecks.Add(1)
	start := time.Now()
	e = d.Verify()
	p.c.NativeNanos.Add(time.Since(start).Nanoseconds())
	if m := p.preparation[platform]; m != nil {
		m.Native.Add(time.Since(start).Nanoseconds())
	}
	return e
}

func (p *Pipeline) verifyWork(ctx context.Context, platform string, tree *library.WorkTree) error {
	start := time.Now()
	err := tree.Verify(ctx, p.Config.Sources[platform])
	elapsed := time.Since(start).Nanoseconds()
	p.c.NativeNanos.Add(elapsed)
	p.c.DirectoryVerifyNanos.Add(elapsed)
	if m := p.preparation[platform]; m != nil {
		m.Native.Add(elapsed)
		m.DirectoryVerify.Add(elapsed)
	}
	return err
}
