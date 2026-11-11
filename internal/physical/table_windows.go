package physical

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"slices"

	"golang.org/x/sys/windows"
)

// The on-disk format protects 512-byte strides even on larger-sector media.
// Logical FSCTL records never go through this repair.
func repairRecord(raw []byte) error {
	if len(raw) < 512 || len(raw)%512 != 0 {
		return errors.New("NTFS_RECORD_GEOMETRY")
	}
	offset := int(binary.LittleEndian.Uint16(raw[4:6]))
	words := int(binary.LittleEndian.Uint16(raw[6:8]))
	if offset < 8 || words != len(raw)/512+1 || offset+words*2 > 510 {
		return errors.New("NTFS_RECORD_UPDATE_ARRAY")
	}
	sequence := binary.LittleEndian.Uint16(raw[offset:])
	for i := 1; i < words; i++ {
		if binary.LittleEndian.Uint16(raw[i*512-2:]) != sequence {
			return errors.New("NTFS_RECORD_TORN")
		}
	}
	for i := 1; i < words; i++ {
		copy(raw[i*512-2:i*512], raw[offset+i*2:offset+i*2+2])
	}
	return nil
}

func (v *ntfsVolume) readDisk(offset int64, buffer []byte) error {
	if _, err := windows.Seek(v.handle, offset, io.SeekStart); err != nil {
		return fmt.Errorf("NTFS_VOLUME_SEEK: %w", err)
	}
	var n uint32
	if err := windows.ReadFile(v.handle, buffer, &n, nil); err != nil {
		return fmt.Errorf("NTFS_VOLUME_READ: %w", err)
	}
	if int(n) != len(buffer) {
		return io.ErrUnexpectedEOF
	}
	return nil
}

func (v *ntfsVolume) readAttribute(runs []extent, size int64) ([]byte, error) {
	if size <= 0 || size > 16<<20 {
		return nil, errors.New("NTFS_ATTRIBUTE_LIST_SIZE")
	}
	buffer := make([]byte, (size+v.cluster-1)/v.cluster*v.cluster)
	if err := v.readStream(runs, 0, buffer); err != nil {
		return nil, err
	}
	return buffer[:size], nil
}

func (v *ntfsVolume) readStream(runs []extent, offset int64, buffer []byte) error {
	for len(buffer) > 0 {
		found := false
		for _, r := range runs {
			start, end := r.Start*v.cluster, (r.Start+r.Clusters)*v.cluster
			if offset < start || offset >= end {
				continue
			}
			if r.LCN < 0 {
				return errors.New("NTFS_TABLE_SPARSE")
			}
			n := min(int64(len(buffer)), end-offset)
			if err := v.readDisk(r.LCN*v.cluster+offset-start, buffer[:n]); err != nil {
				return err
			}
			offset += n
			buffer = buffer[n:]
			found = true
			break
		}
		if !found {
			return errors.New("NTFS_TABLE_EXTENT_MISSING")
		}
	}
	return nil
}

func attributeSegments(list []byte, accept func(kind uint32, ref uint64) error) error {
	for len(list) > 0 {
		if len(list) < 26 {
			return errors.New("NTFS_ATTRIBUTE_LIST_INVALID")
		}
		kind := binary.LittleEndian.Uint32(list[:4])
		size := int(binary.LittleEndian.Uint16(list[4:6]))
		if size < 26 || size > len(list) {
			return errors.New("NTFS_ATTRIBUTE_LIST_INVALID")
		}
		if list[6] == 0 {
			if err := accept(kind, binary.LittleEndian.Uint64(list[16:24])); err != nil {
				return err
			}
		}
		list = list[size:]
	}
	return nil
}

func (v *ntfsVolume) logicalRecord(ref uint64) (fileRecord, error) {
	r, err := v.readRecord(ref)
	if err != nil {
		return r, err
	}
	base := uint64(r.Sequence)<<48 | ref&referenceMask
	if r.Base != 0 {
		return r, errors.New("NTFS_BASE_RECORD_REQUIRED")
	}
	list := r.AttributeList
	if len(r.AttributeRuns) > 0 {
		list, err = v.readAttribute(r.AttributeRuns, r.AttributeSize)
		if err != nil {
			return r, err
		}
	}
	seen := map[uint64]bool{base: true}
	err = attributeSegments(list, func(kind uint32, segment uint64) error {
		if kind != 0x10 && kind != 0x30 && kind != 0x80 || seen[segment] {
			return nil
		}
		seen[segment] = true
		part, err := v.readRecord(segment)
		if err != nil {
			return err
		}
		if part.Base != base {
			return errors.New("NTFS_EXTENSION_REPLACED")
		}
		r.include(part)
		return nil
	})
	return r, err
}

func (r *fileRecord) include(part fileRecord) {
	r.Names = append(r.Names, part.Names...)
	r.Runs = append(r.Runs, part.Runs...)
	if part.DataStart {
		r.DataStart, r.Resident, r.Size = true, part.Resident, part.Size
	}
	if part.Standard {
		r.Standard, r.Reparse, r.Mtime = true, part.Reparse, part.Mtime
	}
}

func (v *ntfsVolume) records(ctx context.Context, accept func(uint64, fileRecord) error) error {
	mft, err := v.logicalRecord(0)
	if err != nil {
		return fmt.Errorf("load NTFS master table extents: %w", err)
	}
	v.mft = mft.Runs
	size := int64(v.mftSize)
	alignment := int64(max(v.sector, v.record))
	if size <= 0 || size%int64(v.record) != 0 || alignment%int64(v.sector) != 0 || alignment%int64(v.record) != 0 {
		return errors.New("NTFS_TABLE_GEOMETRY")
	}
	buffer := make([]byte, max(alignment, (4<<20)/alignment*alignment))
	for offset := int64(0); offset < size; {
		if err = ctx.Err(); err != nil {
			return err
		}
		n := min(int64(len(buffer)), size-offset)
		readSize := (n + int64(v.sector) - 1) / int64(v.sector) * int64(v.sector)
		if err = v.readStream(v.mft, offset, buffer[:readSize]); err != nil {
			return err
		}
		for start := int64(0); start < n; start += int64(v.record) {
			raw := buffer[start : start+int64(v.record)]
			if !slices.Equal(raw[:4], []byte("FILE")) {
				if binary.LittleEndian.Uint32(raw[:4]) == 0 {
					continue
				}
				return errors.New("NTFS_TABLE_RECORD_SIGNATURE")
			}
			if binary.LittleEndian.Uint16(raw[22:24])&1 == 0 {
				continue
			}
			if err = repairRecord(raw); err != nil {
				return err
			}
			r, err := parseRecord(raw)
			if err != nil {
				return err
			}
			ref := uint64((offset+start)/int64(v.record)) | uint64(r.Sequence)<<48
			if err = accept(ref, r); err != nil {
				return err
			}
		}
		offset += n
	}
	return nil
}
