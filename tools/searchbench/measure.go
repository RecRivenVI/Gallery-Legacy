package main

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func measure(ctx context.Context, file string) (map[string]any, error) {
	reader, err := reading.Open(ctx, file, "synthetic-query-corpus", true)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	cases := []struct{ Name, Query string }{
		{"browse", "platform=pixiv&pageSize=48"},
		{"common_cjk_short", "platform=微博&q=风景&pageSize=48"},
		{"single_cjk", "platform=微博&q=漫&pageSize=48"},
		{"latin_word", "platform=微博&q=rain&pageSize=48"},
		{"rare_title", "platform=微博&q=269999&pageSize=48"},
		{"author_name", "platform=微博&q=author-000005&pageSize=48"},
		{"tag", "platform=微博&tag=标签7&pageSize=48"},
		{"deep_page", "platform=微博&page=1080&pageSize=48"},
		{"and_exclusion", "platform=微博&q=风景+-title:269999&pageSize=48"},
		{"field_exact_id", "platform=微博&q=id:269999&pageSize=48"},
		{"multi_tag", "platform=微博&q=tag:标签7+-tag:标签8&pageSize=48"},
		{"mixed_platform", "q=title:风景+platform:微,p&pageSize=48"},
		{"multi_word", "platform=微博&q=rain+风景&pageSize=48"},
	}
	results := []map[string]any{}
	for _, c := range cases {
		params, _ := url.ParseQuery(c.Query)
		samples := []float64{}
		var total int64
		for i := 0; i < 10; i++ {
			start := time.Now()
			value, err := reader.Snapshot(ctx, func(view *reading.View) (any, error) { return view.Page("works", params, nil) })
			if err != nil {
				return nil, fmt.Errorf("measure %s: %w", c.Name, err)
			}
			ms := float64(time.Since(start)) / float64(time.Millisecond)
			row := value.(map[string]any)
			total = row["total"].(int64)
			if i > 0 {
				samples = append(samples, ms)
			}
		}
		sorted := append([]float64{}, samples...)
		sort.Float64s(sorted)
		results = append(results, map[string]any{"name": c.Name, "query": c.Query, "total": total, "samplesMs": samples, "medianMs": sorted[len(sorted)/2], "p95Ms": sorted[len(sorted)-1]})
	}
	return map[string]any{"kind": "synthetic-query-only", "works": 390000, "weiboWorks": 270000, "sourceReads": 0, "scope": "query+count+48-card DTO; no HTTP, browser, thumbnail or scan timing", "cases": results}, nil
}
