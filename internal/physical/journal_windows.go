package physical

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

type journalCursor struct {
	ID          uint64
	First, Next int64
}

func (v *ntfsVolume) journal() (journalCursor, error) {
	var raw [128]byte
	var count uint32
	if err := windows.DeviceIoControl(v.handle, 0x900f4, nil, 0, &raw[0], uint32(len(raw)), &count, nil); err != nil {
		return journalCursor{}, fmt.Errorf("NTFS_JOURNAL_QUERY: %w", err)
	}
	if count < 56 {
		return journalCursor{}, errors.New("NTFS_JOURNAL_INVALID")
	}
	return journalCursor{binary.LittleEndian.Uint64(raw[:8]), max(int64(binary.LittleEndian.Uint64(raw[8:16])), int64(binary.LittleEndian.Uint64(raw[24:32]))), int64(binary.LittleEndian.Uint64(raw[16:24]))}, nil
}

func (j journalCursor) follows(old journalCursor) bool {
	return j.ID == old.ID && old.Next >= j.First && old.Next <= j.Next
}

const (
	usnDeleted   = 0x200
	usnHardLink  = 0x10000
	usnTopology  = 0x100 | usnDeleted | 0x1000 | 0x2000 | 0x100000
	usnDirectory = 0x10
)

type journalChange struct {
	Ref, Parent        uint64
	Reason, Attributes uint32
}

func (v *ntfsVolume) changes(ctx context.Context, old, end journalCursor, accept func(journalChange) error) error {
	if !end.follows(old) {
		return errors.New("NTFS_JOURNAL_DISCONTINUOUS")
	}
	in := make([]byte, 48)
	binary.LittleEndian.PutUint32(in[8:12], ^uint32(0))
	binary.LittleEndian.PutUint64(in[32:40], end.ID)
	binary.LittleEndian.PutUint16(in[40:42], 2)
	binary.LittleEndian.PutUint16(in[42:44], 2)
	out := make([]byte, 1<<20)
	for cursor := old.Next; cursor < end.Next; {
		if err := ctx.Err(); err != nil {
			return err
		}
		binary.LittleEndian.PutUint64(in[:8], uint64(cursor))
		var count uint32
		if err := windows.DeviceIoControl(v.handle, 0x900bb, &in[0], uint32(len(in)), &out[0], uint32(len(out)), &count, nil); err != nil {
			return fmt.Errorf("NTFS_JOURNAL_READ: %w", err)
		}
		if count < 8 {
			return errors.New("NTFS_JOURNAL_INVALID")
		}
		next := int64(binary.LittleEndian.Uint64(out[:8]))
		if next <= cursor {
			return errors.New("NTFS_JOURNAL_STALLED")
		}
		for at := 8; at < int(count); {
			raw := out[at:count]
			if len(raw) < 60 || binary.LittleEndian.Uint16(raw[4:6]) != 2 {
				return errors.New("NTFS_JOURNAL_RECORD_VERSION")
			}
			size := int(binary.LittleEndian.Uint32(raw[:4]))
			usn := int64(binary.LittleEndian.Uint64(raw[24:32]))
			if size < 60 || size > len(raw) || usn < cursor {
				return errors.New("NTFS_JOURNAL_RECORD_INVALID")
			}
			if usn >= end.Next {
				return nil
			}
			if err := accept(journalChange{binary.LittleEndian.Uint64(raw[8:16]), binary.LittleEndian.Uint64(raw[16:24]), binary.LittleEndian.Uint32(raw[40:44]), binary.LittleEndian.Uint32(raw[52:56])}); err != nil {
				return err
			}
			at += size
		}
		cursor = next
	}
	return nil
}
