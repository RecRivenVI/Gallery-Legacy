package task

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func TestScanSelectionRejectsTheSameInvalidInputsAsNode(t *testing.T) {
	for _, tt := range []struct {
		input Row
		code  string
	}{
		{Row{}, "READ_ONLY_CONFIRMATION_REQUIRED"},
		{Row{"confirmReadOnly": "true"}, "READ_ONLY_CONFIRMATION_REQUIRED"},
		{Row{"confirmReadOnly": true, "mode": "unknown"}, "SCAN_MODE_INVALID"},
		{Row{"confirmReadOnly": true, "mode": float64(1)}, "SCAN_MODE_INVALID"},
		{Row{"confirmReadOnly": true, "platformIds": []string{}}, "SCAN_PLATFORM_INVALID"},
		{Row{"confirmReadOnly": true, "platformIds": []string{"pixiv", "pixiv"}}, "SCAN_PLATFORM_INVALID"},
		{Row{"confirmReadOnly": true, "platformId": "pixiv", "authorDirectoryName": "../escape"}, "AUTHOR_DIRECTORY_INVALID"},
	} {
		_, _, err := Parse(tt.input)
		if control.Code(err, "") != tt.code {
			t.Errorf("Parse(%v): %v; want %s", tt.input, err, tt.code)
		}
	}
	in, ids, err := Parse(Row{"confirmReadOnly": true, "platformId": "pixiv", "authorDirectoryName": ""})
	if err != nil || in.Author != nil || len(ids) != 1 {
		t.Fatalf("empty author is not an author-scoped scan: %+v %v %v", in, ids, err)
	}
}

func TestReportFailureRetainsCommittedCountsAndDoesNotClaimSuccess(t *testing.T) {
	root := os.Getenv("GALLERY_CONTROL_ROOT")
	if root == "" {
		t.Skip("explicit synthetic GALLERY_CONTROL_ROOT required")
	}
	p, err := os.MkdirTemp(root, "ReportFailure-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := instance.Recycle(p); e != nil {
			t.Error(e)
		}
	})
	c := instance.Config{ScanStatusPath: filepath.Join(p, "scan.json")}
	err = reportFailure(c, Row{"state": "READY", "running": false, "works": 3}, os.ErrPermission)
	if control.Code(err, "") != "SCAN_REPORT_WRITE_FAILED" {
		t.Fatal(err)
	}
	s, err := State(c)
	if err != nil || s["state"] != "FAILED" || s["running"] != false || s["works"] != float64(3) {
		t.Fatalf("%v %v", s, err)
	}
}

func TestLiveHostCannotKeepAnEndedScanRunning(t *testing.T) {
	root := os.Getenv("GALLERY_CONTROL_ROOT")
	if root == "" {
		t.Skip("explicit synthetic GALLERY_CONTROL_ROOT required")
	}
	p, err := os.MkdirTemp(root, "TaskState-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := instance.Recycle(p); e != nil {
			t.Error(e)
		}
	})
	c := instance.Config{InstanceRoot: p, StateRoot: filepath.Join(p, "state"), InstanceID: "synthetic-task", ScanStatusPath: filepath.Join(p, "state", "scan.json")}
	if err = os.MkdirAll(c.StateRoot, 0700); err != nil {
		t.Fatal(err)
	}
	lease, err := control.Acquire(c, "scan", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if e := lease.Close(); e != nil {
			t.Error(e)
		}
	}()
	if err = lease.BindTask("new-task"); err != nil {
		t.Fatal(err)
	}
	if err = instance.WriteJSON(c.ScanStatusPath, Row{"running": true, "state": "RUNNING", "generationId": "ended-task", "pid": os.Getpid(), "identity": lease.Identity}); err != nil {
		t.Fatal(err)
	}
	state, err := State(c)
	if err != nil {
		t.Fatal(err)
	}
	if state["running"] != false || state["failure"].(map[string]any)["code"] != "SCAN_OWNER_EXITED" {
		t.Fatalf("ended task with live host: %v", state)
	}
	if err = lease.BindTask("ended-task"); err != nil {
		t.Fatal(err)
	}
	state, err = State(c)
	if err != nil || state["running"] != true {
		t.Fatalf("active matching task: %v %v", state, err)
	}
	if err = lease.Close(); err != nil {
		t.Fatal(err)
	}
	state, err = State(c)
	if err != nil || state["running"] != false {
		t.Fatalf("released task with live host: %v %v", state, err)
	}
}
