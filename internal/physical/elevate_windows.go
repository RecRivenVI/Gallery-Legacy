package physical

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type shellExecuteInfo struct {
	Size, Mask                        uint32
	Window                            uintptr
	Verb, File, Parameters, Directory *uint16
	Show                              int32
	Instance                          uintptr
	IDList, Class, ClassKey           uintptr
	HotKey                            uint32
	Icon                              uintptr
	Process                           windows.Handle
}

var shellExecuteEx = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW")

func runElevated(ctx context.Context, exe, request string) error {
	if windows.GetCurrentProcessToken().IsElevated() {
		command := exec.CommandContext(ctx, exe, "--physical-order-helper", request)
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
		if err := command.Run(); err != nil {
			return helperExit(request, fmt.Errorf("NTFS_HELPER_EXIT: %w", err))
		}
		return nil
	}
	file, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	parameters, err := windows.UTF16PtrFromString("--physical-order-helper " + syscall.EscapeArg(request))
	if err != nil {
		return err
	}
	info := shellExecuteInfo{Mask: 0x40 | 0x100 | 0x400, Verb: verb, File: file, Parameters: parameters, Show: windows.SW_HIDE}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, err := shellExecuteEx.Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		return fmt.Errorf("NTFS_HELPER_ELEVATE: %w", err)
	}
	defer windows.CloseHandle(info.Process)
	for {
		status, err := windows.WaitForSingleObject(info.Process, 200)
		if err != nil {
			return fmt.Errorf("NTFS_HELPER_WAIT: %w", err)
		}
		if status == windows.WAIT_OBJECT_0 {
			var code uint32
			if err = windows.GetExitCodeProcess(info.Process, &code); err != nil {
				return err
			}
			if code != 0 {
				return helperExit(request, fmt.Errorf("NTFS_HELPER_EXIT_%d", code))
			}
			return nil
		}
		if err = ctx.Err(); err != nil {
			// The handle is returned by this launch; no PID/name-based targeting.
			stop := windows.TerminateProcess(info.Process, 1)
			_, wait := windows.WaitForSingleObject(info.Process, 5000)
			if stop != nil {
				return fmt.Errorf("NTFS_HELPER_CANCEL: %w", stop)
			}
			if wait != nil {
				return fmt.Errorf("NTFS_HELPER_WAIT: %w", wait)
			}
			return err
		}
	}
}

func helperExit(request string, fallback error) error {
	b, err := os.ReadFile(request + ".error.json")
	if err != nil {
		return fallback
	}
	var detail struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(b, &detail) == nil && detail.Error != "" {
		return fmt.Errorf("%s: %w", detail.Error, fallback)
	}
	return fallback
}
