package physical

import (
	"encoding/binary"
	"reflect"
	"testing"
)

func TestAllocationRunOffsetsAndFragmentedMFTPositions(t *testing.T) {
	runs, err := parseRuns([]byte{0x11, 4, 100, 0x11, 2, 0xf6, 0x01, 1, 0}, 0)
	want := []extent{{0, 4, 100}, {4, 2, 90}, {6, 1, -1}}
	if err != nil || !reflect.DeepEqual(runs, want) {
		t.Fatal(runs, err)
	}
	if at, ok := bytePosition(runs, 4*4096+1024, 4096); !ok || at != 90*4096+1024 {
		t.Fatal("resident record treated as contiguous MFT", at, ok)
	}
	if _, ok := bytePosition(runs, 6*4096, 4096); ok {
		t.Fatal("sparse extent supplied a physical position")
	}
	for _, raw := range [][]byte{{0x11, 1}, {0x00 | 0x10, 1, 0}, {0x11, 0, 10, 0}} {
		if _, err = parseRuns(raw, 0); err == nil {
			t.Fatal("truncated/invalid run accepted")
		}
	}
}

func TestCachedRecordAndResidentDataExposeOnlyAllocationFacts(t *testing.T) {
	b := make([]byte, 1024)
	copy(b, "FILE")
	binary.LittleEndian.PutUint16(b[4:6], 48)
	binary.LittleEndian.PutUint16(b[6:8], 3)
	binary.LittleEndian.PutUint16(b[16:18], 7)
	binary.LittleEndian.PutUint16(b[20:22], 56)
	binary.LittleEndian.PutUint16(b[22:24], 1)
	binary.LittleEndian.PutUint16(b[48:50], 0xfafa)
	binary.LittleEndian.PutUint16(b[510:512], 0xfafa)
	binary.LittleEndian.PutUint16(b[1022:1024], 0xfafa)
	at := 56
	// An unnamed resident DATA attribute. The bytes are deliberately arbitrary;
	// changing them cannot affect the output of the allocation parser.
	binary.LittleEndian.PutUint32(b[at:at+4], 0x80)
	binary.LittleEndian.PutUint32(b[at+4:at+8], 32)
	binary.LittleEndian.PutUint32(b[at+16:at+20], 4)
	binary.LittleEndian.PutUint16(b[at+20:at+22], 24)
	copy(b[at+24:], "test")
	binary.LittleEndian.PutUint32(b[at+32:at+36], 0xffffffff)
	binary.LittleEndian.PutUint32(b[24:28], uint32(at+36))
	r, err := parseRecord(b)
	if err != nil || !r.Resident || r.Size != 4 || r.Sequence != 7 {
		t.Fatal(r, err)
	}
	copy(b[at+24:], "else")
	other, err := parseRecord(b)
	if err != nil || !reflect.DeepEqual(r, other) {
		t.Fatal("resident content leaked into allocation facts")
	}
	b[510] = 0
	if _, err = parseRecord(b); err != nil {
		t.Fatal("cached logical record rejected due to stale sector array", err)
	}
	binary.LittleEndian.PutUint32(b[24:28], 2048)
	if _, err = parseRecord(b); err == nil {
		t.Fatal("invalid record bounds accepted")
	}
}
