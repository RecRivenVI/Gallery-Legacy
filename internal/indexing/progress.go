package indexing

import (
	"context"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
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

func (p *Pipeline) collectInventories(ctx context.Context, l *library.Listing, ids []string) ([]string, error) {
	ordered := append([]string(nil), ids...)
	for _, id := range ids {
		p.setState(id, "LISTING")
		if p.Config.ListingSource != "filesystem" {
			provider := p.Inventory
			if provider == nil {
				provider = library.LocalEverything()
			}
			at := time.Now()
			n, err := l.LoadEverything(ctx, provider, id, p.Config.Sources[id])
			if err != nil {
				if !p.Config.AllowNative {
					return nil, fmt.Errorf("EVERYTHING_CONFIRMATION_REQUIRED: %w", err)
				}
				p.addIssue(id, "", "warning", "EVERYTHING_NATIVE_FALLBACK")
				slog.WarnContext(ctx, "文件清单不可用，按已确认的方式遍历目录", "platform", id, "error", err)
				if err = l.Reset(ctx, id); err != nil {
					return nil, err
				}
			} else {
				p.c.Listings.Add(n)
				slog.InfoContext(ctx, "文件清单读取完成", "platform", id, "entries", n, "elapsedMs", time.Since(at).Milliseconds())
			}
		}
		if !l.Indexed(id) {
			if err := l.LoadNative(ctx, id, p.Config.Sources[id], func(c library.DirectoryCosts) {
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
func (p *Pipeline) addIssue(platform, work, severity, code string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	row := map[string]string{"platformId": platform, "work": work, "severity": severity, "code": code}
	p.issueLog.append(row)
	if severity == "warning" {
		p.c.Warnings.Add(1)
	}
	if len(p.issues) < 200 {
		p.issues = append(p.issues, map[string]string{"platformId": platform, "work": work, "severity": severity, "code": code})
	}
}
