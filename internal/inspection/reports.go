package inspection

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

var reportID = regexp.MustCompile(`^validation-[0-9]+-[a-f0-9]{12}$`)

func reportFile(c instance.Config, id, suffix string) (string, error) {
	if !reportID.MatchString(id) {
		return "", fmt.Errorf("VALIDATION_ID_INVALID")
	}
	p := filepath.Join(c.ReportsRoot, id+suffix)
	return p, library.NoLinks(p)
}
func each(c instance.Config, id string, accept func(Row) bool) (resultErr error) {
	p, err := reportFile(c, id, ".findings.jsonl")
	if err != nil {
		return err
	}
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, f.Close()) }()
	reader := bufio.NewReader(f)
	for {
		line, e := reader.ReadBytes('\n')
		if len(line) > 0 {
			var row Row
			if err = json.Unmarshal(line, &row); err != nil {
				return err
			}
			if !accept(row) {
				return nil
			}
		}
		if e != nil {
			if errors.Is(e, io.EOF) {
				return nil
			}
			return e
		}
	}
}
func Operation(ctx context.Context, c instance.Config, op string, input Row) (value any, err error) {
	if op == "validation.checks" {
		checks, e := api.LoadChecks()
		return Row{"items": checks}, e
	}
	s, err := Status(c)
	if err != nil {
		return nil, err
	}
	if op == "validation.status" {
		delete(s, "identity")
		return s, nil
	}
	if op == "validation.cancel" {
		if s["running"] != true {
			return nil, fmt.Errorf("VALIDATION_NOT_RUNNING")
		}
		return Row{"requested": true}, instance.WriteJSON(filepath.Join(c.StateRoot, "validation-cancel.json"), Row{"id": s["id"]})
	}
	id, _ := input["id"].(string)
	if input["id"] == nil {
		id, _ = s["id"].(string)
	}
	switch op {
	case "validation.findings":
		return query(c, id, input)
	case "validation.location":
		var match Row
		if err = each(c, id, func(row Row) bool {
			if row["index"] == input["index"] {
				match = row
				return false
			}
			return true
		}); err != nil {
			return nil, err
		}
		if match == nil {
			return nil, fmt.Errorf("VALIDATION_FINDING_MISSING")
		}
		p, _ := match["platformId"].(string)
		root := c.Sources[p]
		if root == "" {
			return nil, fmt.Errorf("INVALID_PLATFORM")
		}
		rel, _ := match["relativePath"].(string)
		target, e := library.Join(root, rel)
		if rel == "" {
			target, e = root, nil
		}
		if e != nil {
			return nil, e
		}
		return Row{"path": target}, library.NoLinks(target)
	case "validation.export":
		return export(c, id, input)
	case "validation.purge":
		if input["confirm"] != true {
			return nil, fmt.Errorf("CONFIRMATION_REQUIRED")
		}
		lease, e := control.Acquire(c, "maintenance", nil)
		if e != nil {
			return nil, e
		}
		defer func() { err = errors.Join(err, lease.Close()) }()
		if s["running"] == true {
			return nil, fmt.Errorf("VALIDATION_IN_USE")
		}
		for _, suffix := range []string{".json", ".findings.jsonl", ".export.json", ".export.csv"} {
			p, e := reportFile(c, id, suffix)
			if e != nil {
				return nil, e
			}
			if _, e = os.Lstat(p); e == nil {
				if e = instance.Recycle(p); e != nil {
					return nil, e
				}
			} else if !os.IsNotExist(e) {
				return nil, e
			}
		}
		return Row{"removed": true}, nil
	}
	return nil, fmt.Errorf("MANAGEMENT_OPERATION_INVALID")
}
func query(c instance.Config, id string, input Row) (any, error) {
	page, limit := float64(1), float64(100)
	if input["page"] != nil {
		var ok bool
		page, ok = input["page"].(float64)
		if !ok {
			return nil, fmt.Errorf("VALIDATION_QUERY_INVALID")
		}
	}
	if input["limit"] != nil {
		var ok bool
		limit, ok = input["limit"].(float64)
		if !ok {
			return nil, fmt.Errorf("VALIDATION_QUERY_INVALID")
		}
	}
	q := ""
	if input["query"] != nil {
		var ok bool
		q, ok = input["query"].(string)
		if !ok {
			return nil, fmt.Errorf("VALIDATION_QUERY_INVALID")
		}
	}
	if page < 1 || page != float64(int64(page)) || limit < 1 || limit > 200 || limit != float64(int64(limit)) || len([]rune(q)) > 256 {
		return nil, fmt.Errorf("VALIDATION_QUERY_INVALID")
	}
	q = strings.ToLower(q)
	items := []Row{}
	total := 0
	err := each(c, id, func(row Row) bool {
		for _, pair := range [][2]string{{"check", "code"}, {"severity", "severity"}, {"platformId", "platformId"}} {
			if v := input[pair[0]]; v != nil && v != "" && v != row[pair[1]] {
				return true
			}
		}
		rel, _ := row["relativePath"].(string)
		if q != "" && !strings.Contains(strings.ToLower(rel), q) {
			return true
		}
		if float64(total) >= (page-1)*limit && len(items) < int(limit) {
			items = append(items, row)
		}
		total++
		return true
	})
	return Row{"id": id, "page": page, "limit": limit, "total": total, "items": items}, err
}
func export(c instance.Config, id string, input Row) (any, error) {
	format := "json"
	if input["format"] != nil {
		format, _ = input["format"].(string)
	}
	if format != "json" && format != "csv" {
		return nil, fmt.Errorf("VALIDATION_FORMAT_INVALID")
	}
	file, err := reportFile(c, id, ".export."+format)
	if err != nil {
		return nil, err
	}
	f, err := os.Create(file)
	if err != nil {
		return nil, err
	}
	count := 0
	write := func(text string) {
		if err == nil {
			_, err = f.WriteString(text)
		}
	}
	if format == "json" {
		write("[\n")
	} else {
		write("platform,check,severity,relativePath\r\n")
	}
	quote := func(value any) string {
		text, _ := value.(string)
		if len(text) > 0 && strings.ContainsAny(text[:1], "=+@-") {
			text = "'" + text
		}
		return `"` + strings.ReplaceAll(text, `"`, `""`) + `"`
	}
	e := each(c, id, func(row Row) bool {
		if format == "json" {
			b, e := json.Marshal(row)
			if e != nil {
				err = e
				return false
			}
			if count > 0 {
				write(",\n")
			}
			write(string(b))
		} else {
			write(quote(row["platformId"]) + "," + quote(row["code"]) + "," + quote(row["severity"]) + "," + quote(row["relativePath"]) + "\r\n")
		}
		count++
		return err == nil
	})
	if format == "json" {
		write("\n]\n")
	}
	err = errors.Join(err, e, f.Close())
	return Row{"file": filepath.Base(file), "count": count, "format": format}, err
}
