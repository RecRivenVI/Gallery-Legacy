package physical

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

type ntfsVolume struct {
	handle         windows.Handle
	sector, record int
	cluster        int64
	mft            []extent
}

func openVolume(root string) (*ntfsVolume, error) {
	name := filepath.VolumeName(root)
	if len(name) != 2 || name[1] != ':' {
		return nil, errors.New("NTFS_VOLUME_REQUIRED")
	}
	p, err := windows.UTF16PtrFromString(`\\.\` + name)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return nil, fmt.Errorf("NTFS_VOLUME_OPEN: %w", err)
	}
	v := &ntfsVolume{handle: h}
	b := make([]byte, 128)
	var n uint32
	if err = windows.DeviceIoControl(h, 0x90064, nil, 0, &b[0], uint32(len(b)), &n, nil); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("NTFS_VOLUME_QUERY: %w", err)
	}
	if n < 104 || binary.LittleEndian.Uint16(b[100:102]) != 3 {
		windows.CloseHandle(h)
		return nil, errors.New("NTFS_VERSION_UNSUPPORTED")
	}
	v.sector = int(binary.LittleEndian.Uint32(b[40:44]))
	v.cluster = int64(binary.LittleEndian.Uint32(b[44:48]))
	v.record = int(binary.LittleEndian.Uint32(b[48:52]))
	if v.sector == 0 || v.cluster == 0 || v.record < 48 || v.record > 1<<20 {
		windows.CloseHandle(h)
		return nil, errors.New("NTFS_GEOMETRY_INVALID")
	}
	r, err := v.readRecord(0)
	if err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	v.mft = r.Runs
	return v, nil
}

func (v *ntfsVolume) close() { windows.CloseHandle(v.handle) }

func (v *ntfsVolume) readRecord(ref uint64) (fileRecord, error) {
	in := make([]byte, 8)
	binary.LittleEndian.PutUint64(in, ref)
	out := make([]byte, v.record+16)
	var n uint32
	err := windows.DeviceIoControl(v.handle, 0x90068, &in[0], uint32(len(in)), &out[0], uint32(len(out)), &n, nil)
	if err != nil {
		return fileRecord{}, fmt.Errorf("NTFS_RECORD_READ: %w", err)
	}
	if n < 12 || binary.LittleEndian.Uint64(out[:8])&referenceMask != ref&referenceMask {
		return fileRecord{}, errors.New("NTFS_RECORD_REPLACED")
	}
	size := int(binary.LittleEndian.Uint32(out[8:12]))
	if size > v.record || 12+size > int(n) {
		return fileRecord{}, errors.New("NTFS_RECORD_INVALID")
	}
	r, err := parseRecord(out[12 : 12+size])
	if err != nil {
		return r, err
	}
	if ref>>48 != 0 && r.Sequence != uint16(ref>>48) {
		return r, errors.New("NTFS_RECORD_REPLACED")
	}
	return r, nil
}

func (v *ntfsVolume) position(ref uint64, r fileRecord) (int64, bool) {
	if r.Resident {
		return bytePosition(v.mft, int64(ref&referenceMask)*int64(v.record), v.cluster)
	}
	return bytePosition(r.Runs, 0, v.cluster)
}

// Only requested basenames leave this callback; the scope resolver then keeps
// exact selected paths below approved roots. Other names are never retained.
func (v *ntfsVolume) fileReferences(ctx context.Context, names map[string]bool, accept func(uint64) error) error {
	in := make([]byte, 24)
	binary.LittleEndian.PutUint64(in[16:24], math.MaxInt64)
	out := make([]byte, 1<<20)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		var n uint32
		err := windows.DeviceIoControl(v.handle, 0x900b3, &in[0], uint32(len(in)), &out[0], uint32(len(out)), &n, nil)
		if errors.Is(err, windows.ERROR_HANDLE_EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("NTFS_ENUMERATE: %w", err)
		}
		if n < 8 {
			return io.ErrUnexpectedEOF
		}
		next := binary.LittleEndian.Uint64(out[:8])
		if next <= binary.LittleEndian.Uint64(in[:8]) {
			return errors.New("NTFS_ENUMERATION_STALLED")
		}
		for at := 8; at < int(n); {
			if at+60 > int(n) {
				return errors.New("NTFS_USN_RECORD_INVALID")
			}
			raw := out[at:n]
			size := int(binary.LittleEndian.Uint32(raw[:4]))
			if size < 60 || at+size > int(n) || binary.LittleEndian.Uint16(raw[4:6]) != 2 {
				return errors.New("NTFS_USN_VERSION_UNSUPPORTED")
			}
			length, offset := int(binary.LittleEndian.Uint16(raw[56:58])), int(binary.LittleEndian.Uint16(raw[58:60]))
			if offset+length > size || length%2 != 0 {
				return errors.New("NTFS_USN_RECORD_INVALID")
			}
			if names[strings.ToLower(decodeName(raw[offset:offset+length]))] {
				if err = accept(binary.LittleEndian.Uint64(raw[8:16])); err != nil {
					return err
				}
			}
			at += size
		}
		binary.LittleEndian.PutUint64(in[:8], next)
	}
}

func directoryReference(path string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateFile(p, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &info); err != nil {
		return 0, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return 0, errors.New("NTFS_SCOPE_INVALID")
	}
	return uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow), nil
}
