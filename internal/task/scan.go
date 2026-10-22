// Package task owns scan process state; the actual parser and writer remain indexing.
package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/indexing"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/recovery"
	"github.com/google/uuid"
)

type Row = map[string]any
type ScanInput struct {
	Mode        string   `json:"mode"`
	PlatformID  *string  `json:"platformId"`
	PlatformIDs []string `json:"platformIds"`
	Author      *string  `json:"authorDirectoryName"`
	Confirm     bool     `json:"confirmReadOnly"`
}

func Parse(value Row) (ScanInput, []string, error) {
	if value["confirmReadOnly"] != true {
		return ScanInput{}, nil, fmt.Errorf("READ_ONLY_CONFIRMATION_REQUIRED")
	}
	if mode := value["mode"]; mode != nil {
		if _, ok := mode.(string); !ok {
			return ScanInput{}, nil, fmt.Errorf("SCAN_MODE_INVALID")
		}
	}
	if id := value["platformId"]; id != nil {
		if _, ok := id.(string); !ok {
			return ScanInput{}, nil, fmt.Errorf("SCAN_PLATFORM_INVALID")
		}
	}
	if ids := value["platformIds"]; ids != nil {
		b, e := json.Marshal(ids)
		var list []string
		if e != nil || json.Unmarshal(b, &list) != nil {
			return ScanInput{}, nil, fmt.Errorf("SCAN_PLATFORM_INVALID")
		}
	}
	if author := value["authorDirectoryName"]; author != nil {
		if _, ok := author.(string); !ok {
			return ScanInput{}, nil, fmt.Errorf("AUTHOR_DIRECTORY_INVALID")
		}
	}
	b, err := json.Marshal(value)
	var in ScanInput
	if err == nil {
		err = json.Unmarshal(b, &in)
	}
	if err != nil {
		return in, nil, fmt.Errorf("MANAGEMENT_INPUT_INVALID")
	}
	if !in.Confirm {
		return in, nil, fmt.Errorf("READ_ONLY_CONFIRMATION_REQUIRED")
	}
	if in.Mode == "" {
		in.Mode = "full"
	}
	if in.Author != nil && *in.Author == "" {
		in.Author = nil
	}
	if in.Mode != "full" && in.Mode != "incremental" {
		return in, nil, fmt.Errorf("SCAN_MODE_INVALID")
	}
	if in.PlatformID != nil && in.PlatformIDs != nil {
		return in, nil, fmt.Errorf("SCAN_PLATFORM_INVALID")
	}
	selected := in.PlatformIDs
	if in.PlatformID != nil {
		selected = []string{*in.PlatformID}
	}
	contract, err := api.LoadCatalog()
	if err != nil {
		return in, nil, err
	}
	all := []string{}
	for _, p := range contract.Platforms {
		all = append(all, p.ID)
	}
	if selected == nil {
		selected = all
	}
	set := map[string]bool{}
	for _, id := range selected {
		if set[id] {
			return in, nil, fmt.Errorf("SCAN_PLATFORM_INVALID")
		}
		set[id] = true
	}
	ordered := []string{}
	for _, id := range all {
		if set[id] {
			ordered = append(ordered, id)
		}
	}
	if len(ordered) != len(selected) || len(ordered) == 0 {
		return in, nil, fmt.Errorf("SCAN_PLATFORM_INVALID")
	}
	if in.Author != nil && (*in.Author == "" || len(ordered) != 1 || strings.ContainsAny(*in.Author, `\/:`+"\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f") || *in.Author == "." || *in.Author == "..") {
		return in, nil, fmt.Errorf("AUTHOR_DIRECTORY_INVALID")
	}
	return in, ordered, nil
}

func State(c instance.Config) (Row, error) {
	s := Row{}
	err := control.ReadJSON(c.ScanStatusPath, &s)
	if os.IsNotExist(err) {
		return Row{"running": false, "state": "IDLE"}, nil
	}
	if err != nil {
		return nil, err
	}
	if s["running"] == true {
		b, _ := json.Marshal(s["identity"])
		var expected *control.Identity
		if json.Unmarshal(b, &expected) != nil || expected == nil {
			return nil, fmt.Errorf("OWNER_UNVERIFIABLE")
		}
		owner, err := control.Owner(c, "scan")
		if err != nil {
			return nil, err
		}
		if owner == nil || !control.Same(owner.Identity, expected) || owner.TaskID != "" && owner.TaskID != s["generationId"] {
			var latest Row
			if control.ReadJSON(c.ScanStatusPath, &latest) == nil && latest["running"] == false && latest["generationId"] == s["generationId"] && latest["pid"] == s["pid"] {
				return latest, nil
			}
			s["running"] = false
			s["state"] = "FAILED"
			s["failure"] = Row{"code": "SCAN_OWNER_EXITED"}
		}
	}
	return s, nil
}
func Cancel(c instance.Config) (any, error) {
	s, err := State(c)
	if err != nil {
		return nil, err
	}
	if s["running"] != true {
		return nil, fmt.Errorf("SCAN_NOT_RUNNING")
	}
	if s["state"] == "PUBLISHING" || s["state"] == "READY" {
		return nil, fmt.Errorf("SCAN_COMMIT_IN_PROGRESS")
	}
	err = instance.WriteJSON(filepath.Join(c.StateRoot, "scan-cancel.json"), Row{"generationId": s["generationId"], "requestedAtMs": time.Now().UnixMilli()})
	return Row{"requested": true}, err
}

// Run owns the writer until completion, including cancellation and lease release.
func Run(ctx context.Context, c instance.Config, in ScanInput, ids []string, delay time.Duration, notify func(Row)) (err error) {
	owner, err := control.Acquire(c, "scan", nil)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, owner.Close()) }()
	id := "scan-" + uuid.NewString()
	if err = owner.BindTask(id); err != nil {
		return err
	}
	started := time.Now()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-finished:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				var request Row
				if control.ReadJSON(filepath.Join(c.StateRoot, "scan-cancel.json"), &request) == nil && request["generationId"] == id {
					cancel()
					return
				}
			}
		}
	}()
	var last Row
	var persistError error
	var persistMu sync.Mutex
	persist := func(s indexing.Status) {
		persistMu.Lock()
		defer persistMu.Unlock()
		b, _ := s.MarshalJSON()
		var r Row
		_ = json.Unmarshal(b, &r)
		counts, _ := r["counts"].(map[string]any)
		if counts == nil {
			counts = Row{}
		}
		progress, _ := r["progress"].(map[string]any)
		if progress == nil {
			progress = Row{}
		}
		r["protocolVersion"] = 1
		r["pid"] = os.Getpid()
		r["identity"] = owner.Identity
		r["generationId"] = id
		r["mode"] = in.Mode
		r["effectiveMode"] = in.Mode
		r["startedAtMs"] = started.UnixMilli()
		if r["state"] == "COMPLETE" {
			// The writer is complete, but final facts/report and lease release are
			// still part of the task. Do not enable the next scan prematurely.
			r["state"] = "VALIDATING"
			r["running"] = true
		}
		for k, v := range map[string]string{"works": "worksCommitted", "indexedWorks": "worksCommitted", "observedWorks": "worksPrepared", "reusedWorks": "worksReused", "actualMedia": "mediaCommitted", "diagnosticCount": "failures"} {
			value := counts[v]
			if value == nil {
				value = 0
			}
			r[k] = value
		}
		for k, v := range map[string]string{"platforms": "platformResults", "platformResults": "platformResults", "activePlatforms": "activePlatforms", "metadataStates": "metadataStates"} {
			r[k] = progress[v]
		}
		r["scope"] = Row{"requestedPlatformIds": ids, "effectivePlatformIds": ids, "authorDirectoryName": in.Author}
		if s.Failure != "" {
			r["failure"] = Row{"code": s.Failure}
		} else {
			r["failure"] = nil
		}
		last = r
		if e := instance.WriteJSON(c.ScanStatusPath, r); e != nil && persistError == nil {
			persistError = fmt.Errorf("SCAN_STATUS_WRITE_FAILED: %w", e)
			cancel()
		}
	}
	persist(indexing.Status{Running: true, State: "PREPARING", Phase: "LISTING", Counts: map[string]int64{}})
	if persistError != nil {
		return persistError
	}
	if notify != nil {
		notify(Row{"started": true, "pid": os.Getpid(), "generationId": id})
	}
	slog.Info("更新开始", "event", "scan.start", "mode", in.Mode)
	workingRoot, err := runPipeline(ctx, c, in, ids, id, delay, persist)
	if err == nil && persistError == nil && !c.LiveUpdates {
		_, err = recovery.Build(ctx, c, id, filepath.Join(workingRoot, "live/catalog.sqlite"))
		if err == nil {
			lease, e := control.Acquire(c, "maintenance", nil)
			if e != nil {
				err = e
			} else {
				last["state"] = "PUBLISHING"
				last["running"] = true
				err = instance.WriteJSON(c.ScanStatusPath, last)
				if err == nil {
					err = recovery.Publish(c, id)
				}
				err = errors.Join(err, lease.Close())
			}
		}
	}
	var counts Row
	if err == nil && persistError == nil {
		// Once the complete write/publication succeeded, finish its bookkeeping
		// during manager shutdown rather than relabeling committed success.
		counts, err = reportCounts(context.WithoutCancel(ctx), c, workingRoot)
	}
	if persistError != nil {
		err = persistError
	}
	if err != nil {
		code := control.Code(err, "SCAN_NOT_COMPLETE")
		state := "FAILED"
		if ctx.Err() != nil && persistError == nil {
			code = "SCAN_CANCELLED"
			state = "CANCELLED"
		}
		last["state"] = state
		last["running"] = false
		last["finishedAtMs"] = time.Now().UnixMilli()
		last["failure"] = Row{"code": code}
		event := "scan.failed"
		if state == "CANCELLED" {
			event = "scan.cancelled"
		}
		slog.Warn("更新结束", "event", event, "code", code, "counts", last["counts"])
		if e := instance.WriteJSON(c.ScanStatusPath, last); e != nil {
			return e
		}
		return fmt.Errorf("%s", code)
	}
	report := Row{"state": "READY", "generationId": id, "mode": in.Mode, "effectiveMode": in.Mode, "changes": last["changes"], "scope": last["scope"], "elapsedMs": time.Since(started).Milliseconds(), "searchRebuilt": false, "sourceWriteAttempts": nil, "scanner": "go", "counts": last["counts"]}
	report["catalog"] = Row{"workCount": counts["works"], "mediaCount": counts["media"]}
	report["build"] = Row{"counts": counts}
	report["searchRebuilt"] = !c.LiveUpdates
	if err = instance.WriteJSON(filepath.Join(c.ReportsRoot, id+".json"), report); err != nil {
		return reportFailure(c, last, err)
	}
	last["state"], last["running"] = "READY", false
	last["finishedAtMs"] = time.Now().UnixMilli()
	if err = instance.WriteJSON(c.ScanStatusPath, last); err != nil {
		return err
	}
	slog.Info("更新完成", "event", "scan.complete", "mode", in.Mode, "changes", last["changes"], "elapsedMs", time.Since(started).Milliseconds())
	if workingRoot != c.InstanceRoot {
		return instance.Recycle(workingRoot)
	}
	return nil
}
