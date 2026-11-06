package library

import (
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

var user32 = windows.NewLazySystemDLL("user32.dll")
var enumWindows = user32.NewProc("EnumWindows")
var getClassName = user32.NewProc("GetClassNameW")
var getWindowPID = user32.NewProc("GetWindowThreadProcessId")
var sendMessageTimeout = user32.NewProc("SendMessageTimeoutW")
var extendedTCP = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

type readinessProbe struct {
	pid   uint32
	ready bool
}

var readinessProbes sync.Map
var readinessSequence atomic.Uint64
var readinessCallback = windows.NewCallback(func(hwnd, data uintptr) uintptr {
	value, found := readinessProbes.Load(data)
	if !found {
		return 0
	}
	probe := value.(*readinessProbe)
	var owner uint32
	getWindowPID.Call(hwnd, uintptr(unsafe.Pointer(&owner)))
	if owner != probe.pid {
		return 1
	}
	var name [256]uint16
	getClassName.Call(hwnd, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
	if !strings.HasPrefix(windows.UTF16ToString(name[:]), "EVERYTHING_TASKBAR_NOTIFICATION") {
		return 1
	}
	var loaded, busy uintptr
	// Official IPC: WM_USER, IS_DB_LOADED=401, IS_DB_BUSY=402.
	ok, _, _ := sendMessageTimeout.Call(hwnd, 0x400, 401, 0, 2, 2000, uintptr(unsafe.Pointer(&loaded)))
	if ok != 0 && loaded == 1 {
		ok, _, _ = sendMessageTimeout.Call(hwnd, 0x400, 402, 0, 2, 2000, uintptr(unsafe.Pointer(&busy)))
		probe.ready = ok != 0 && busy == 0
	}
	return 0
})

// Query only the local HTTP owner's IPC window. A different Everything instance
// being ready must not qualify the instance serving port 54321.
func everythingReady(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var size uint32
	extendedTCP.Call(0, uintptr(unsafe.Pointer(&size)), 0, windows.AF_INET, 5, 0)
	if size < 4 {
		return errors.New("EVERYTHING_UNAVAILABLE")
	}
	b := make([]byte, size)
	code, _, _ := extendedTCP.Call(uintptr(unsafe.Pointer(&b[0])), uintptr(unsafe.Pointer(&size)), 0, windows.AF_INET, 5, 0)
	if code != 0 {
		return errors.New("EVERYTHING_UNAVAILABLE")
	}
	var pid uint32
	for i := uint32(0); i < binary.LittleEndian.Uint32(b[:4]); i++ {
		offset := 4 + int(i)*24
		if offset+24 > len(b) {
			return errors.New("EVERYTHING_UNAVAILABLE")
		}
		row := b[offset : offset+24]
		if binary.LittleEndian.Uint32(row[:4]) == 2 && binary.BigEndian.Uint16(row[8:10]) == 54321 {
			pid = binary.LittleEndian.Uint32(row[20:24])
			break
		}
	}
	if pid == 0 {
		return errors.New("EVERYTHING_UNAVAILABLE")
	}
	probe := readinessProbe{pid: pid}
	id := uintptr(readinessSequence.Add(1))
	readinessProbes.Store(id, &probe)
	enumWindows.Call(readinessCallback, id)
	readinessProbes.Delete(id)
	if !probe.ready {
		return errors.New("EVERYTHING_NOT_READY")
	}
	return nil
}
