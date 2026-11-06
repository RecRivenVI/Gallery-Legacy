// Package physical obtains NTFS allocation hints for ordered metadata reads.
// It never reads media data or uses allocation hints as authority to delete.
package physical

import (
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf16"
)

const referenceMask uint64 = 1<<48 - 1

type extent struct{ Start, Clusters, LCN int64 }
type fileName struct {
	Parent    uint64
	Name      string
	Namespace byte
}
type fileRecord struct {
	Sequence    uint16
	Names       []fileName
	Directory   bool
	Reparse     bool
	Size, Mtime int64
	Resident    bool
	Runs        []extent
}

// Layout follows Microsoft's NTFS v3 FILE_RECORD_SEGMENT_HEADER,
// ATTRIBUTE_RECORD_HEADER and FILE_NAME specifications. Resident DATA bytes
// are deliberately not decoded or returned.
func parseRecord(data []byte) (fileRecord, error) {
	var record fileRecord
	bad := func(reason string) error { return fmt.Errorf("NTFS_RECORD_INVALID: %s", reason) }
	if len(data) < 48 || string(data[:4]) != "FILE" {
		return record, bad("signature")
	}
	// FSCTL returns the filesystem's logical record. Its cached sector tails
	// can differ from the last on-disk update sequence array; repairing that
	// array here would corrupt already-fixed attribute bytes.
	record.Sequence = binary.LittleEndian.Uint16(data[16:18])
	flags := binary.LittleEndian.Uint16(data[22:24])
	if flags&1 == 0 {
		return record, bad("not_in_use")
	}
	record.Directory = flags&2 != 0
	used := int(binary.LittleEndian.Uint32(data[24:28]))
	if used < 48 || used > len(data) {
		return record, bad("record_length")
	}
	for at := int(binary.LittleEndian.Uint16(data[20:22])); at+4 <= used; {
		kind := binary.LittleEndian.Uint32(data[at : at+4])
		if kind == 0xffffffff {
			return record, nil
		}
		if at < 48 || at+24 > used {
			return record, bad("attribute_header")
		}
		size := int(binary.LittleEndian.Uint32(data[at+4 : at+8]))
		if size < 24 || at+size > used {
			return record, bad("attribute_length")
		}
		attr := data[at : at+size]
		if attr[8] == 0 {
			offset, length := int(binary.LittleEndian.Uint16(attr[20:22])), int(binary.LittleEndian.Uint32(attr[16:20]))
			if offset < 24 || offset+length > len(attr) {
				return record, bad("resident_bounds")
			}
			value := attr[offset : offset+length]
			switch kind {
			case 0x10:
				if len(value) < 36 {
					return record, bad("standard_information")
				}
				record.Mtime = (int64(binary.LittleEndian.Uint64(value[8:16])) - 116444736000000000) * 100
				record.Reparse = binary.LittleEndian.Uint32(value[32:36])&0x400 != 0
			case 0x30:
				if len(value) < 66 {
					return record, bad("file_name_header")
				}
				length := int(value[64]) * 2
				if 66+length > len(value) {
					return record, bad("file_name_length")
				}
				name := decodeName(value[66 : 66+length])
				record.Names = append(record.Names, fileName{binary.LittleEndian.Uint64(value[:8]), name, value[65]})
			case 0x80:
				if attr[9] == 0 {
					record.Resident = true
					record.Size = int64(length)
				}
			}
		} else if kind == 0x80 && attr[9] == 0 {
			if len(attr) < 64 {
				return record, bad("nonresident_header")
			}
			offset := int(binary.LittleEndian.Uint16(attr[32:34]))
			if offset < 64 || offset >= len(attr) {
				return record, bad("nonresident_mapping")
			}
			start := int64(binary.LittleEndian.Uint64(attr[16:24]))
			runs, err := parseRuns(attr[offset:], start)
			if err != nil {
				return record, err
			}
			record.Runs = append(record.Runs, runs...)
			if start == 0 {
				record.Size = int64(binary.LittleEndian.Uint64(attr[48:56]))
			}
		}
		at += size
	}
	return record, bad("missing_attribute_terminator")
}

func decodeName(data []byte) string {
	runes := make([]uint16, len(data)/2)
	for i := range runes {
		runes[i] = binary.LittleEndian.Uint16(data[i*2 : i*2+2])
	}
	return string(utf16.Decode(runes))
}

func parseRuns(data []byte, start int64) ([]extent, error) {
	var result []extent
	lcn := int64(0)
	for at := 0; at < len(data); {
		header := data[at]
		at++
		if header == 0 {
			return result, nil
		}
		lengthBytes, offsetBytes := int(header&15), int(header>>4)
		if lengthBytes < 1 || lengthBytes > 8 || offsetBytes > 8 || at+lengthBytes+offsetBytes > len(data) {
			return nil, errors.New("NTFS_RUNLIST_INVALID")
		}
		length := decodeUnsigned(data[at : at+lengthBytes])
		at += lengthBytes
		if length == 0 || length > 1<<63-1 {
			return nil, errors.New("NTFS_RUNLIST_INVALID")
		}
		physical := int64(-1)
		if offsetBytes > 0 {
			offset := decodeUnsigned(data[at : at+offsetBytes])
			if data[at+offsetBytes-1]&0x80 != 0 && offsetBytes < 8 {
				offset |= ^uint64(0) << (offsetBytes * 8)
			}
			lcn += int64(offset)
			physical = lcn
			if lcn < 0 {
				return nil, errors.New("NTFS_RUNLIST_INVALID")
			}
		}
		at += offsetBytes
		result = append(result, extent{start, int64(length), physical})
		start += int64(length)
	}
	return nil, errors.New("NTFS_RUNLIST_INVALID")
}

func decodeUnsigned(data []byte) uint64 {
	var value uint64
	for i, b := range data {
		value |= uint64(b) << (i * 8)
	}
	return value
}

func bytePosition(runs []extent, offset, cluster int64) (int64, bool) {
	if cluster <= 0 || offset < 0 {
		return 0, false
	}
	vcn := offset / cluster
	for _, r := range runs {
		if r.LCN >= 0 && vcn >= r.Start && vcn-r.Start < r.Clusters {
			return (r.LCN+vcn-r.Start)*cluster + offset%cluster, true
		}
	}
	return 0, false
}
