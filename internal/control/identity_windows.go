// Package control implements the existing authenticated local ownership protocol.
package control

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/windows"
)

type Identity struct {
	PID   uint32 `json:"pid"`
	Start string `json:"start"`
	Exe   string `json:"exe"`
}

// Node persists .NET UTC ticks truncated to microseconds. Preserve those bytes,
// not a formatted timestamp or a PID-only approximation of ownership.
func ProcessIdentity(pid uint32) (*Identity, error) {
	if pid == 0 {
		return nil, fmt.Errorf("OWNER_INVALID")
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err == windows.ERROR_INVALID_PARAMETER {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("OWNER_UNVERIFIABLE: %w", err)
	}
	defer windows.CloseHandle(h)
	var exit uint32
	if err = windows.GetExitCodeProcess(h, &exit); err != nil {
		return nil, fmt.Errorf("OWNER_UNVERIFIABLE: %w", err)
	}
	if exit != 259 {
		return nil, nil
	}
	var created, ended, kernel, user windows.Filetime
	if err = windows.GetProcessTimes(h, &created, &ended, &kernel, &user); err != nil {
		return nil, fmt.Errorf("OWNER_UNVERIFIABLE: %w", err)
	}
	buf := make([]uint16, 32768)
	n := uint32(len(buf))
	if err = windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return nil, fmt.Errorf("OWNER_UNVERIFIABLE: %w", err)
	}
	ticks := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	ticks += 504911232000000000
	return &Identity{pid, strconv.FormatUint(ticks-ticks%10, 10), strings.ToLower(windows.UTF16ToString(buf[:n]))}, nil
}

func Same(a, b *Identity) bool { return a != nil && b != nil && *a == *b }
func Pipe(root, scope string) string {
	key := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(root)) + "/" + scope))
	return `\\.\pipe\gallery-` + hex.EncodeToString(key[:16])
}
