package indexing

import (
	"context"
	"errors"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"sort"
	"time"
)

// Root/author membership discovery and work preparation share the same
// physical-device I/O permits. Membership is written to the existing private
// listing index; no complete platform tree is retained in memory.
func (p *Pipeline) enumerate(ctx context.Context, l *library.Listing, platform, relative string) (library.Directory, error) {
	release, e := p.disk(ctx, p.Config.Sources[platform])
	if e != nil {
		return library.Directory{}, e
	}
	defer release()
	return p.enumerateHeld(ctx, l, platform, relative, nil)
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

func (p *Pipeline) verifyWorkDirectories(platform string, directories []library.Directory) error {
	for _, d := range directories {
		p.c.NativeChecks.Add(1)
		start := time.Now()
		e := d.VerifyLeaf()
		elapsed := time.Since(start).Nanoseconds()
		p.c.NativeNanos.Add(elapsed)
		if m := p.preparation[platform]; m != nil {
			m.Native.Add(elapsed)
		}
		if e != nil {
			return e
		}
	}
	return nil
}

// Called with one disk permit already held. ReadDir order is not identity
// order: sort only this bounded work after observation for stable signatures.
func (p *Pipeline) nativeWork(ctx context.Context, l *library.Listing, platform string, work library.Entry) ([]library.Entry, []library.Directory, error) {
	entries := []library.Entry{work}
	positions := map[string]int{work.Key: 0}
	directories := []library.Directory{}
	var walk func(library.Entry, int) error
	walk = func(dir library.Entry, depth int) error {
		if depth > 128 {
			return errors.New("WORK_DEPTH_BUDGET_EXCEEDED")
		}
		folders := []library.Entry{}
		d, e := p.enumerateHeld(ctx, l, platform, dir.Relative, func(batch []library.Entry) error {
			if len(entries)+len(batch) > 131072 {
				return errors.New("WORK_LISTING_BUDGET_EXCEEDED")
			}
			for _, child := range batch {
				positions[child.Key] = len(entries)
				entries = append(entries, child)
				if child.Kind == "folder" {
					folders = append(folders, child)
				}
			}
			return nil
		})
		if e != nil {
			return e
		}
		directories = append(directories, d)
		// Replace cached parent timestamps with the directory's own facts.
		entries[positions[dir.Key]].Mtime = d.Info.ModTime().UnixNano()
		for _, child := range folders {
			if e = walk(child, depth+1); e != nil {
				return e
			}
		}
		return nil
	}
	if e := walk(work, 0); e != nil {
		return nil, nil, e
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Key < entries[j].Key })
	return entries, directories, nil
}
