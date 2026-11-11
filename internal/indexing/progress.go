package indexing

import (
	"context"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/physical"
	"log/slog"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

type platformProgress struct {
	totalWorks, totalAuthors, entries                    int64
	works, skippedWorks, authors, skippedAuthors, failed atomic.Int64
}

type inventoryProvider func(context.Context, *library.Listing, library.Config, []string, string, bool) error

func loadFileTables(ctx context.Context, l *library.Listing, c library.Config, ids []string, author string, incremental bool) error {
	if err := physical.Inventory(ctx, c, ids, author, incremental); err != nil {
		return err
	}
	for _, id := range ids {
		_, limit := library.Disk(c.Sources[id])
		if _, err := l.LoadFileTable(ctx, c.InstanceRoot, id, c.Sources[id], author, !incremental && limit == 2); err != nil {
			return err
		}
	}
	return nil
}

func (p *Pipeline) collectInventories(ctx context.Context, l *library.Listing, ids []string) ([]string, error) {
	ordered := append([]string(nil), ids...)
	for _, id := range ids {
		p.setState(id, "LISTING")
	}
	if p.Config.ListingSource != "filesystem" {
		provider := p.Inventory
		if provider == nil {
			provider = loadFileTables
		}
		at := time.Now()
		if err := provider(ctx, l, p.Config, ids, p.AuthorDirectoryName, p.Mode == "incremental"); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if !p.Config.AllowNative {
				return nil, fmt.Errorf("FILE_TABLE_CONFIRMATION_REQUIRED: %w", err)
			}
			p.addIssue("", "", "warning", "FILE_TABLE_NATIVE_FALLBACK")
			slog.WarnContext(ctx, "文件表不可用，按已确认的方式遍历目录", "error", err)
			for _, id := range ids {
				if err = l.Reset(ctx, id); err != nil {
					return nil, err
				}
				if err = l.ClearPositions(ctx, id); err != nil {
					return nil, err
				}
			}
		} else {
			p.c.Listings.Add(l.Entries.Load())
			slog.InfoContext(ctx, "文件表清单读取完成", "platforms", len(ids), "entries", l.Entries.Load(), "elapsedMs", time.Since(at).Milliseconds())
		}
	}
	for _, id := range ids {
		if !l.Indexed(id) {
			if err := l.LoadNativeScope(ctx, id, p.Config.Sources[id], p.AuthorDirectoryName, func(c library.DirectoryCosts) {
				p.c.DirectoryReads.Add(1)
				p.c.DirectoryOpenNanos.Add(c.Open.Nanoseconds())
				p.c.DirectoryReadNanos.Add(c.Read.Nanoseconds())
				p.c.DirectoryMapNanos.Add(c.Map.Nanoseconds())
				p.c.DirectoryVerifyNanos.Add(c.Verify.Nanoseconds())
				p.c.EnumerationNanos.Add((c.Open + c.Read + c.Map + c.Verify).Nanoseconds())
			}); err != nil {
				return nil, err
			}
		}
		if _, err := p.enumerate(ctx, l, id, "."); err != nil {
			return nil, err
		}
		for after := ""; ; {
			authors, err := l.Page(ctx, id, ".", after)
			if err != nil {
				return nil, err
			}
			if len(authors) == 0 {
				break
			}
			for _, a := range authors {
				if p.AuthorDirectoryName != "" && !strings.EqualFold(a.Name, p.AuthorDirectoryName) {
					continue
				}
				if _, err = p.enumerate(ctx, l, id, a.Relative); err != nil {
					return nil, err
				}
			}
			after = authors[len(authors)-1].Key
		}
		stat := p.platformProgress[id]
		p.mu.Lock()
		err := l.DB.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(kind='folder' AND work=key),0),coalesce(sum(kind='folder' AND parent='.'),0) FROM entries WHERE platform=? AND (?='' OR key=? OR substr(key,1,length(?)+1)=?||'\')`, id, p.AuthorDirectoryName, strings.ToLower(p.AuthorDirectoryName), strings.ToLower(p.AuthorDirectoryName), strings.ToLower(p.AuthorDirectoryName)).Scan(&stat.entries, &stat.totalWorks, &stat.totalAuthors)
		p.mu.Unlock()
		if err != nil {
			return nil, err
		}
		if id == "Venera" {
			p.mu.Lock()
			stat.totalAuthors = 0
			p.mu.Unlock()
		}
		p.setState(id, "QUEUED")
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		return p.platformProgress[ordered[i]].entries < p.platformProgress[ordered[j]].entries
	})
	return ordered, nil
}

func (p *Pipeline) completeWork(id string, reused bool, err error) {
	s := p.platformProgress[id]
	if err != nil {
		s.failed.Add(1)
		return
	}
	s.works.Add(1)
	if reused {
		s.skippedWorks.Add(1)
	}
}
func (p *Pipeline) addIssue(platform, work, severity, code string, details ...string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	row := map[string]string{"platformId": platform, "work": work, "severity": severity, "code": code}
	if len(details) > 0 {
		row["details"] = strings.Join(details, " · ")
	}
	p.issueLog.append(row)
	if severity == "warning" {
		p.c.Warnings.Add(1)
	}
	if len(p.issues) < 200 {
		p.issues = append(p.issues, row)
	}
}
