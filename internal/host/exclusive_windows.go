package host

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"golang.org/x/sys/windows"
)

func exclusiveDatabases(root string) error {
	return filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.IsDir() || !regexp.MustCompile(`(?i)\.sqlite(?:-wal|-shm|-journal)?$`).MatchString(e.Name()) {
			return nil
		}
		name, err := windows.UTF16PtrFromString(p)
		if err != nil {
			return err
		}
		h, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, 0, 0)
		if err != nil {
			return fmt.Errorf("RETENTION_DATABASE_IN_USE: %w", err)
		}
		return windows.CloseHandle(h)
	})
}
