package control

import (
	"errors"
	"fmt"
	"testing"
)

func TestStableCodeSurvivesContextAndCleanupErrors(t *testing.T) {
	for _, err := range []error{
		fmt.Errorf("observe source: %w", errors.New("PATH_REPARSE")),
		errors.Join(fmt.Errorf("read author: %w", errors.New("PATH_REPARSE")), errors.New("temporary cleanup failed")),
	} {
		if Code(err, "FAILED") != "PATH_REPARSE" {
			t.Fatal("wrapped public code changed", err)
		}
	}
	if Code(fmt.Errorf("SCAN_STATUS_WRITE_FAILED: %w", errors.New("permission denied")), "FAILED") != "SCAN_STATUS_WRITE_FAILED" {
		t.Fatal("explicit boundary code lost")
	}
}
