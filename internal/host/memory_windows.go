package host

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

func residentMemory() uint64 {
	var counter struct {
		Size, Faults                                                                                        uint32
		Peak, Working, QuotaPeakPaged, QuotaPaged, QuotaPeakNonPaged, QuotaNonPaged, Pagefile, PeakPagefile uintptr
	}
	counter.Size = uint32(unsafe.Sizeof(counter))
	_, _, _ = windows.NewLazySystemDLL("psapi.dll").NewProc("GetProcessMemoryInfo").Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&counter)), uintptr(counter.Size))
	return uint64(counter.Working)
}
