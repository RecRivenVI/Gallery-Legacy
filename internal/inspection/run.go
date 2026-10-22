package inspection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/google/uuid"
)

type Selection struct {
	Checks   []string
	Platform string
}

func Select(c instance.Config, input Row) (Selection, error) {
	var s Selection
	if input["confirmReadOnly"] != true {
		return s, fmt.Errorf("READ_ONLY_CONFIRMATION_REQUIRED")
	}
	checks, err := api.LoadChecks()
	if err != nil {
		return s, err
	}
	valid := map[string]bool{}
	for _, check := range checks {
		valid[check.ID] = true
	}
	if input["checks"] == nil {
		for _, check := range checks {
			s.Checks = append(s.Checks, check.ID)
		}
	} else {
		ids, ok := input["checks"].([]any)
		if !ok || len(ids) == 0 {
			return s, fmt.Errorf("VALIDATION_CHECK_INVALID")
		}
		seen := map[string]bool{}
		for _, id := range ids {
			text, ok := id.(string)
			if !ok || !valid[text] {
				return s, fmt.Errorf("VALIDATION_CHECK_INVALID")
			}
			if !seen[text] {
				s.Checks = append(s.Checks, text)
				seen[text] = true
			}
		}
	}
	if id := input["platformId"]; id != nil && id != "" {
		var ok bool
		s.Platform, ok = id.(string)
		if !ok || c.Sources[s.Platform] == "" {
			return s, fmt.Errorf("INVALID_PLATFORM")
		}
	}
	return s, nil
}
func stateFile(c instance.Config) string { return filepath.Join(c.StateRoot, "validation.json") }
func Status(c instance.Config) (Row, error) {
	s := Row{}
	err := control.ReadJSON(stateFile(c), &s)
	if os.IsNotExist(err) {
		return Row{"state": "IDLE", "running": false}, nil
	}
	if err != nil {
		return nil, err
	}
	if s["running"] == true {
		b, _ := json.Marshal(s["identity"])
		var id *control.Identity
		if json.Unmarshal(b, &id) != nil || id == nil {
			return nil, fmt.Errorf("OWNER_UNVERIFIABLE")
		}
		owner, err := control.Owner(c, "validation")
		if err != nil {
			return nil, err
		}
		if owner == nil || !control.Same(owner.Identity, id) || owner.TaskID != "" && owner.TaskID != s["id"] {
			var latest Row
			if control.ReadJSON(stateFile(c), &latest) == nil && latest["id"] == s["id"] && latest["running"] == false {
				return latest, nil
			}
			s["state"], s["running"], s["error"] = "FAILED", false, "VALIDATION_OWNER_EXITED"
		}
	}
	return s, nil
}
func Run(ctx context.Context, c instance.Config, selection Selection, notify func(Row)) (err error) {
	var maintenance *control.Lease
	deadline := time.Now().Add(8 * time.Second)
	for {
		maintenance, err = control.Acquire(c, "maintenance", nil)
		if err == nil {
			break
		}
		if control.Code(err, "") != "INSTANCE_IN_USE" || time.Now().After(deadline) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	defer func() { err = errors.Join(err, maintenance.Close()) }()
	scan, err := control.Acquire(c, "scan", nil)
	if err != nil {
		return fmt.Errorf("SCAN_IN_USE: %w", err)
	}
	defer func() { err = errors.Join(err, scan.Close()) }()
	lease, err := control.Acquire(c, "validation", nil)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lease.Close()) }()
	id := fmt.Sprintf("validation-%d-%.12s", time.Now().UnixMilli(), stringsID())
	if err = scan.BindTask(id); err != nil {
		return err
	}
	if err = lease.BindTask(id); err != nil {
		return err
	}
	counts := map[string]int{}
	s := Row{"id": id, "state": "RUNNING", "running": true, "pid": os.Getpid(), "identity": lease.Identity, "startedAtMs": time.Now().UnixMilli(), "works": 0, "authors": 0, "total": 0, "counts": counts, "checks": selection.Checks, "truncated": false}
	file, err := reportFile(c, id, ".findings.jsonl")
	if err != nil {
		return err
	}
	f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(f)
	checks, err := api.LoadChecks()
	if err != nil {
		return errors.Join(err, f.Close())
	}
	severity := map[string]string{}
	enabled := map[string]bool{}
	for _, rule := range checks {
		severity[rule.ID] = rule.Severity
	}
	for _, id := range selection.Checks {
		enabled[id] = true
	}
	last := time.Time{}
	persist := func(force bool) error {
		if !force && time.Since(last) < 500*time.Millisecond {
			return nil
		}
		last = time.Now()
		return instance.WriteJSON(stateFile(c), s)
	}
	if err = persist(true); err != nil {
		return errors.Join(err, f.Close())
	}
	initial := Row{}
	for k, v := range s {
		if k != "identity" {
			initial[k] = v
		}
	}
	initial["counts"] = map[string]int{}
	notify(initial)
	var writeErr error
	add := func(code, platform, relative string, detail Row) {
		if writeErr != nil || !enabled[code] {
			return
		}
		counts[code]++
		total := s["total"].(int) + 1
		s["total"] = total
		if total > 100000 {
			s["truncated"] = true
			return
		}
		writeErr = encoder.Encode(Row{"index": total, "code": code, "severity": severity[code], "platformId": platform, "relativePath": relative, "detail": detail})
	}
	cancellation := func() error {
		if e := ctx.Err(); e != nil {
			return fmt.Errorf("VALIDATION_CANCELLED")
		}
		var request Row
		if control.ReadJSON(filepath.Join(c.StateRoot, "validation-cancel.json"), &request) == nil && request["id"] == id {
			return fmt.Errorf("VALIDATION_CANCELLED")
		}
		return writeErr
	}
	o := observer{
		Author: func() { s["authors"] = s["authors"].(int) + 1 },
		Issue:  add,
		Work: func(w work) error {
			if e := cancellation(); e != nil {
				return e
			}
			s["works"] = s["works"].(int) + 1
			findings(w, func(code string, detail Row) { add(code, w.Platform, w.Relative, detail) })
			if writeErr != nil {
				return writeErr
			}
			return persist(false)
		},
	}
	for _, p := range c.Platforms {
		if selection.Platform != "" && p.ID != selection.Platform {
			continue
		}
		if err = cancellation(); err != nil {
			break
		}
		s["platformId"] = p.ID
		if err = persist(true); err != nil {
			break
		}
		if err = o.platform(ctx, c, p.ID, ""); err != nil {
			break
		}
	}
	if err == nil {
		err = cancellation()
	}
	s["state"] = "COMPLETED"
	if err != nil {
		s["state"] = "FAILED"
		s["error"] = control.Code(err, "VALIDATION_FAILED")
		if ctx.Err() != nil || control.Code(err, "") == "VALIDATION_CANCELLED" {
			s["state"], s["error"] = "CANCELLED", "VALIDATION_CANCELLED"
		}
	}
	s["running"] = false
	s["finishedAtMs"] = time.Now().UnixMilli()
	s["elapsedMs"] = s["finishedAtMs"].(int64) - s["startedAtMs"].(int64)
	err = errors.Join(err, f.Close(), persist(true))
	delete(s, "identity")
	file, e := reportFile(c, id, ".json")
	if e != nil {
		return errors.Join(err, e)
	}
	return errors.Join(err, instance.WriteJSON(file, s))
}
func stringsID() string { id := uuid.New(); return fmt.Sprintf("%x", id[:]) }
