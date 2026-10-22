package inspection

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func Scope(ctx context.Context, c instance.Config, input Row) (any, error) {
	if input["confirmReadOnly"] != true {
		return nil, fmt.Errorf("READ_ONLY_CONFIRMATION_REQUIRED")
	}
	id, _ := input["platformId"].(string)
	if c.Sources[id] == "" {
		return nil, fmt.Errorf("INVALID_PLATFORM")
	}
	author := ""
	if input["authorDirectoryName"] != nil {
		var ok bool
		author, ok = input["authorDirectoryName"].(string)
		if !ok {
			return nil, fmt.Errorf("AUTHOR_DIRECTORY_INVALID")
		}
	}
	if strings.ContainsAny(author, "\\/:\x00") || author == "." || author == ".." {
		return nil, fmt.Errorf("AUTHOR_DIRECTORY_INVALID")
	}
	for _, r := range author {
		if r < 32 {
			return nil, fmt.Errorf("AUTHOR_DIRECTORY_INVALID")
		}
	}
	if author != "" {
		target := filepath.Join(c.Sources[id], author)
		if err := library.NoLinks(target); err != nil {
			return nil, err
		}
		st, err := os.Stat(target)
		if err != nil {
			return nil, err
		}
		if !st.IsDir() {
			return nil, fmt.Errorf("AUTHOR_DIRECTORY_INVALID")
		}
	}
	states := map[string]int{}
	scope := "platform-sample"
	if author != "" {
		scope = "selected-author"
	}
	result := Row{"platformId": id, "scope": scope, "limit": 1000, "works": 0, "media": 0, "authors": 0, "incompleteWorks": 0, "metadataStates": states, "diagnostics": 0, "truncated": false, "catalogModified": false, "enumerationComplete": true}
	stop := errors.New("CHECK_LIMIT")
	o := observer{Author: func() { result["authors"] = result["authors"].(int) + 1 }, Issue: func(code, p, rel string, detail Row) {
		result["diagnostics"] = result["diagnostics"].(int) + 1
		if code == "filesystem.unreadable" && rel == "" {
			result["enumerationComplete"] = false
		}
	}, Work: func(w work) error {
		if result["works"].(int) >= 1000 {
			return stop
		}
		result["works"] = result["works"].(int) + 1
		if !w.Complete {
			result["incompleteWorks"] = result["incompleteWorks"].(int) + 1
		}
		for _, f := range w.Files {
			if library.MediaKind(filepath.Ext(f.Name)) != "" && !strings.EqualFold(f.Name, "metadata.json") {
				result["media"] = result["media"].(int) + 1
			}
		}
		state := w.MetadataState
		if state == "present" {
			state = "valid"
			if !w.Parsed.Valid {
				state = w.Parsed.Reason
				if state == "" {
					state = "invalid"
				}
			}
		}
		states[state]++
		return nil
	}}
	err := o.platform(ctx, c, id, author)
	if errors.Is(err, stop) {
		result["truncated"] = true
		result["enumerationComplete"] = false
		err = nil
	}
	if err != nil {
		return nil, err
	}
	name := fmt.Sprintf("manager-scope-%d.json", time.Now().UnixMilli())
	result["report"] = name
	return result, instance.WriteJSON(filepath.Join(c.ReportsRoot, name), result)
}
