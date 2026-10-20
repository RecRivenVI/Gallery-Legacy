package library

import (
	"encoding/binary"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var kernel = windows.NewLazySystemDLL("kernel32.dll")
var volumePath = kernel.NewProc("GetVolumePathNameW")
var mediaCache sync.Map

// Attributes suffice for ancestry checks. Read them afresh for every check;
// never cache a path's safety. File identity is obtained on leaf handles below.
func NoLinks(path string) error {
	at := filepath.Clean(path)
	for {
		p, e := directoryPath(at)
		if e != nil {
			return e
		}
		attrs, e := windows.GetFileAttributes(p)
		if e == nil && attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("PATH_REPARSE")
		}
		if e != nil && !os.IsNotExist(e) {
			return errors.New("PATH_UNAVAILABLE")
		}
		next := filepath.Dir(at)
		if at == next {
			return nil
		}
		at = next
	}
}

func directoryPath(path string) (*uint16, error) {
	// Win32 APIs do not perform os.Open's extended-path conversion for us.
	if len(path) >= 248 && !strings.HasPrefix(path, `\\?\`) {
		absolute, e := filepath.Abs(path)
		if e != nil {
			return nil, e
		}
		if strings.HasPrefix(absolute, `\\`) {
			path = `\\?\UNC\` + absolute[2:]
		} else {
			path = `\\?\` + absolute
		}
	}
	return windows.UTF16PtrFromString(path)
}

func directoryAttributes(st os.FileInfo) (uint32, error) {
	attrs, ok := st.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return 0, errors.New("SOURCE_HANDLE_UNVERIFIABLE")
	}
	return attrs.FileAttributes, nil
}

// Take identity and mtime from one no-follow, read-only attribute handle.
// Lstat's lazy identity would reopen the path inside SameFile, after the
// observation; this captures identity at the observation itself instead.
func observeDirectoryLeaf(path string) (os.FileInfo, error) {
	p, e := directoryPath(path)
	if e != nil {
		return nil, e
	}
	h, e := windows.CreateFile(p, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(h), path)
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return nil, e
	}
	attrs, e := directoryAttributes(st)
	if e != nil {
		return nil, e
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return nil, errors.New("PATH_REPARSE")
	}
	if !st.IsDir() {
		return nil, errors.New("NOT_DIRECTORY")
	}
	return st, nil
}

type diskInfo struct {
	Key   string
	Limit int
}

func Disk(root string) (string, int) {
	buf := make([]uint16, 1024)
	p, e := windows.UTF16PtrFromString(root)
	if e != nil {
		return filepath.VolumeName(root), 2
	}
	r, _, _ := volumePath.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	volume := filepath.VolumeName(root) + "\\"
	if r != 0 {
		volume = windows.UTF16ToString(buf)
	}
	key := strings.ToLower(volume)
	cacheKey := key
	if cached, ok := mediaCache.Load(key); ok {
		v := cached.(diskInfo)
		return v.Key, v.Limit
	}
	key = "physical-disk-unknown"
	limit := 2
	// StorageDeviceSeekPenaltyProperty: conservatively classify unknown as HDD.
	device, e := windows.UTF16PtrFromString(`\\.\` + strings.TrimRight(volume, "\\"))
	if e == nil {
		h, e := windows.CreateFile(device, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
		if e == nil {
			deviceNumber := make([]byte, 12)
			var numberBytes uint32
			if windows.DeviceIoControl(h, 0x2d1080, nil, 0, &deviceNumber[0], 12, &numberBytes, nil) == nil && numberBytes >= 12 {
				key = "physical-disk-" + fmt.Sprint(binary.LittleEndian.Uint32(deviceNumber[4:8]))
			}
			query := make([]byte, 12)
			binary.LittleEndian.PutUint32(query, 7)
			out := make([]byte, 64)
			var returned uint32
			e = windows.DeviceIoControl(h, 0x2d1400, &query[0], uint32(len(query)), &out[0], uint32(len(out)), &returned, nil)
			windows.CloseHandle(h)
			if e == nil && returned >= 9 && out[8] == 0 {
				limit = 32
			}
		}
	}
	mediaCache.Store(cacheKey, diskInfo{key, limit})
	return key, limit
}
func Lease(path string) (func(), error) {
	if e := NoLinks(path); e != nil {
		return nil, e
	}
	p, e := windows.UTF16PtrFromString(path)
	if e != nil {
		return nil, e
	}
	h, e := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if e != nil {
		return nil, e
	}
	var o windows.Overlapped
	e = windows.LockFileEx(h, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &o)
	if e != nil {
		windows.CloseHandle(h)
		return nil, errors.New("SCAN_ALREADY_RUNNING")
	}
	return func() { windows.UnlockFileEx(h, 0, 1, 0, &o); windows.CloseHandle(h) }, nil
}
func ReadSource(root, path string, limit int64) ([]byte, os.FileInfo, error) {
	return readSource(root, path, limit, nil)
}

// Typical source paths fit in a small stack buffer. Keep the same normalized
// handle query and maximum length, growing only for an actually long path.
// No path result or security decision is cached between observations.
func finalHandlePath(h windows.Handle) (string, error) {
	var small [1024]uint16
	return finalHandlePathBuffer(h, small[:])
}

func finalHandlePathBuffer(h windows.Handle, buf []uint16) (string, error) {
	n, e := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if e != nil || n == 0 {
		return "", errors.New("SOURCE_HANDLE_UNVERIFIABLE")
	}
	if n >= uint32(len(buf)) {
		if n > 32768 {
			return "", errors.New("SOURCE_HANDLE_UNVERIFIABLE")
		}
		size := n
		if size < 32768 {
			size++
		}
		buf = make([]uint16, size)
		n, e = windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
		if e != nil || n == 0 || n >= uint32(len(buf)) {
			return "", errors.New("SOURCE_HANDLE_UNVERIFIABLE")
		}
	}
	return strings.TrimPrefix(windows.UTF16ToString(buf[:n]), `\\?\`), nil
}

// Enumeration itself stays in os.File.ReadDir. These checks ensure that the
// read-only directory handle opened by the standard library is the intended
// physical path, even if an ancestor is replaced while opening it.
func openDirectory(root, path string) (*os.File, os.FileInfo, error) {
	if !Inside(root, path) {
		return nil, nil, errors.New("SOURCE_ESCAPE")
	}
	before, e := ObserveDirectory(path)
	if e != nil {
		return nil, nil, e
	}
	return openObservedDirectory(root, path, before)
}

func openObservedDirectory(root, path string, before os.FileInfo) (*os.File, os.FileInfo, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, nil, e
	}
	fail := func(e error) (*os.File, os.FileInfo, error) { f.Close(); return nil, nil, e }
	h := windows.Handle(f.Fd())
	st, e := f.Stat()
	if e != nil {
		return fail(e)
	}
	attrs, e := directoryAttributes(st)
	if e != nil {
		return fail(e)
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fail(errors.New("PATH_REPARSE"))
	}
	final, e := finalHandlePath(h)
	if e != nil {
		return fail(e)
	}
	if !Inside(root, final) || !strings.EqualFold(filepath.Clean(final), filepath.Clean(path)) {
		return fail(errors.New("SOURCE_HANDLE_ESCAPE"))
	}
	if !st.IsDir() || !os.SameFile(before, st) || !before.ModTime().Equal(st.ModTime()) {
		return fail(errors.New("DIRECTORY_CHANGED_DURING_SCAN"))
	}
	return f, st, nil
}

func verifyDirectoryHandle(f *os.File, root, path string) error {
	final, e := finalHandlePath(windows.Handle(f.Fd()))
	if e != nil {
		return e
	}
	if !Inside(root, final) || !strings.EqualFold(filepath.Clean(final), filepath.Clean(path)) {
		return errors.New("DIRECTORY_CHANGED_DURING_SCAN")
	}
	return nil
}

// Listing attributes are checked on the same verified, read-only handle that
// supplies the bytes, rather than a separate path stat before opening the file.
func ReadListedSource(root, path string, limit, size, mtime int64) ([]byte, os.FileInfo, error) {
	return readSource(root, path, limit, func(st os.FileInfo) error {
		if !st.Mode().IsRegular() {
			return errors.New("FILESYSTEM_INCOMPLETE")
		}
		if st.Size() != size || st.ModTime().UnixNano()/100 != mtime/100 {
			return errors.New("METADATA_CHANGED_SINCE_LISTING")
		}
		return nil
	})
}
func readSource(root, path string, limit int64, listed func(os.FileInfo) error) ([]byte, os.FileInfo, error) {
	if !Inside(root, path) {
		return nil, nil, errors.New("SOURCE_ESCAPE")
	}
	p, e := windows.UTF16PtrFromString(path)
	if e != nil {
		return nil, nil, e
	}
	h, e := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_SEQUENTIAL_SCAN, 0)
	if e != nil {
		return nil, nil, e
	}
	f := os.NewFile(uintptr(h), path)
	defer f.Close()
	var info windows.ByHandleFileInformation
	if e = windows.GetFileInformationByHandle(h, &info); e != nil {
		return nil, nil, e
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return nil, nil, errors.New("PATH_REPARSE")
	}
	final, e := finalHandlePath(h)
	if e != nil {
		return nil, nil, e
	}
	if !Inside(root, final) {
		return nil, nil, errors.New("SOURCE_HANDLE_ESCAPE")
	}
	before, e := f.Stat()
	if e != nil {
		return nil, nil, e
	}
	if listed != nil {
		if e = listed(before); e != nil {
			return nil, before, e
		}
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return nil, before, errors.New("METADATA_TOO_LARGE")
	}
	// The verified handle already supplies the exact bounded size. Allocate
	// once, with one extra byte to detect growth, instead of ReadAll's repeated
	// reallocations. The same before/after stat and exact-byte check remain.
	data := make([]byte, int(before.Size())+1)
	nread, e := io.ReadFull(f, data)
	if e != nil && e != io.EOF && e != io.ErrUnexpectedEOF {
		return nil, before, e
	}
	data = data[:nread]
	after, e := f.Stat()
	if e != nil {
		return nil, before, e
	}
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || int64(len(data)) != after.Size() {
		return nil, after, errors.New("METADATA_CHANGED_DURING_READ")
	}
	return data, after, nil
}
