package task

import (
	"bufio"
	"encoding/json"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"os"
	"path/filepath"
)

func Issues(c instance.Config, page int) (Row, error) {
	if page < 1 {
		return nil, fmt.Errorf("INVALID_INPUT")
	}
	file := filepath.Join(c.StateRoot, "scan-issues.jsonl")
	if err := library.NoLinks(file); err != nil {
		return nil, err
	}
	f, err := os.Open(file)
	items := []Row{}
	if os.IsNotExist(err) {
		return Row{"items": items, "page": page, "totalPages": 0}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 256<<10)
	total := 0
	for scanner.Scan() {
		if total >= (page-1)*50 && len(items) < 50 {
			var row Row
			if err = json.Unmarshal(scanner.Bytes(), &row); err != nil {
				return nil, fmt.Errorf("SCAN_ISSUES_INVALID: %w", err)
			}
			items = append(items, row)
		}
		total++
	}
	if err = scanner.Err(); err != nil {
		return nil, err
	}
	return Row{"items": items, "page": page, "pageSize": 50, "total": total, "totalPages": (total + 49) / 50}, nil
}
