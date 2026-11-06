package indexing

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"os"
	"path/filepath"
)

type issueLog struct {
	file *os.File
	err  error
}

func newIssueLog(root string) (*issueLog, error) {
	path := filepath.Join(root, "state", "scan-issues.jsonl")
	if err := library.NoLinks(path); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return nil, fmt.Errorf("SCAN_ISSUES_WRITE_FAILED: %w", err)
	}
	return &issueLog{file: f}, nil
}
func (l *issueLog) append(row map[string]string) {
	if l == nil || l.err != nil {
		return
	}
	data, err := json.Marshal(row)
	if err == nil {
		_, err = l.file.Write(append(data, '\n'))
	}
	if err != nil {
		l.err = fmt.Errorf("SCAN_ISSUES_WRITE_FAILED: %w", err)
	}
}
func (l *issueLog) close() error {
	if l == nil || l.file == nil {
		return nil
	}
	err := errors.Join(l.err, l.file.Sync(), l.file.Close())
	l.file = nil
	return err
}
