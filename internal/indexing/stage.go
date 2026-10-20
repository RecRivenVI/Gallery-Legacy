package indexing

import (
	"bufio"
	"context"
	"encoding/gob"
	"encoding/json"
	"errors"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"io"
	"os"
	"sync"
	"time"
)

func init() {
	gob.Register(map[string]any{})
	gob.Register([]any{})
	gob.Register([]map[string]any{})
	gob.Register(json.Number(""))
}

// A platform is prepared into a private sequential spool, not another Catalog.
// No platform can reach the live writer before its complete scope has sealed.
// The spool preserves int64 values and bounds memory to a few prepared works.
type stageRecord struct {
	Work, Empty                *catalog.PreparedWork
	Authority                  *catalog.PreparedWork
	Platform, Key, Fingerprint string
	Complete                   bool
}
type platformStage struct {
	id          string
	file        *os.File
	buffer      *bufio.Writer
	encoder     *gob.Encoder
	mu          sync.Mutex
	jobs        sync.WaitGroup
	authorSlots chan struct{}
	err         error
	sealed      bool
	records     int64
	queuedAt    time.Time
}

func newStage(root, id string) (*platformStage, error) {
	f, e := os.CreateTemp(root, "platform-*.spool")
	if e != nil {
		return nil, e
	}
	b := bufio.NewWriterSize(f, 64<<10)
	return &platformStage{id: id, file: f, buffer: b, encoder: gob.NewEncoder(b)}, nil
}
func (s *platformStage) fail(e error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err == nil {
		s.err = e
	}
}
func (s *platformStage) append(m message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sealed {
		return errors.New("PLATFORM_ALREADY_SEALED")
	}
	if s.err != nil {
		return s.err
	}
	e := s.encoder.Encode(stageRecord{Work: m.work, Empty: m.empty, Authority: m.authority, Platform: m.platform, Key: m.key, Fingerprint: m.fingerprint, Complete: m.complete})
	if e != nil {
		s.err = e
		return e
	}
	s.records++
	return nil
}
func (s *platformStage) seal() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	if e := s.buffer.Flush(); e != nil {
		return e
	}
	if e := s.file.Sync(); e != nil {
		return e
	}
	if e := s.file.Close(); e != nil {
		return e
	}
	s.sealed = true
	s.queuedAt = time.Now()
	return nil
}
func (s *platformStage) consume(ctx context.Context, accept func(message) error) error {
	if !s.sealed {
		return errors.New("PLATFORM_NOT_SEALED")
	}
	f, e := os.Open(s.file.Name())
	if e != nil {
		return e
	}
	defer f.Close()
	d := gob.NewDecoder(bufio.NewReaderSize(f, 64<<10))
	for i := int64(0); i < s.records; i++ {
		if e = ctx.Err(); e != nil {
			return e
		}
		var r stageRecord
		if e = d.Decode(&r); e != nil {
			return errors.New("PLATFORM_SPOOL_INCOMPLETE")
		}
		if e = accept(message{work: r.Work, empty: r.Empty, authority: r.Authority, platform: r.Platform, key: r.Key, fingerprint: r.Fingerprint, complete: r.Complete}); e != nil {
			return e
		}
	}
	var r stageRecord
	if e = d.Decode(&r); e != io.EOF {
		return errors.New("PLATFORM_SPOOL_INVALID")
	}
	return nil
}
func (s *platformStage) close() { s.file.Close(); os.Remove(s.file.Name()) }
