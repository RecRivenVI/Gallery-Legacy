package indexing

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

type preparationMetrics struct{ Works, Admission, Total, Enumeration, Native, Read, Parse, Mapping, DirectoryOpen, DirectoryRead, DirectoryMap, DirectoryVerify atomic.Int64 }

func (m *preparationMetrics) snapshot() map[string]int64 {
	return map[string]int64{"works": m.Works.Load(), "admissionWaitMs": m.Admission.Load() / 1000000, "totalMs": m.Total.Load() / 1000000, "enumerationMs": m.Enumeration.Load() / 1000000, "nativeVerifyMs": m.Native.Load() / 1000000, "metadataReadMs": m.Read.Load() / 1000000, "metadataParseMs": m.Parse.Load() / 1000000, "mappingMs": m.Mapping.Load() / 1000000, "directoryOpenMs": m.DirectoryOpen.Load() / 1000000, "directoryReadMs": m.DirectoryRead.Load() / 1000000, "directoryMapMs": m.DirectoryMap.Load() / 1000000, "directoryVerifyMs": m.DirectoryVerify.Load() / 1000000}
}

type preparationRequest struct {
	ctx     context.Context
	disk    chan struct{}
	done    chan struct{}
	granted bool
	err     error
}

// Called with admissionMu held. FIFO among eligible requests: a full device
// cannot reserve global capacity, and a full global pool cannot reserve a disk.
// The queue is bounded by the existing author/work windows, not a new producer.
func (p *Pipeline) dispatchPreparation() {
	// No request can become eligible while the global pool is full. Pending
	// cancellations remove themselves under the same mutex, so capacity-free
	// arrivals/releases need not walk the entire bounded queue again.
	if len(p.prepareSlots) == cap(p.prepareSlots) {
		return
	}
	remaining := p.admissionQueue[:0]
	for i, request := range p.admissionQueue {
		if err := request.ctx.Err(); err != nil {
			request.err = err
			close(request.done)
			continue
		}
		if len(p.prepareSlots) == cap(p.prepareSlots) {
			remaining = append(remaining, p.admissionQueue[i:]...)
			break
		}
		granted := false
		select {
		case p.prepareSlots <- struct{}{}:
			select {
			case request.disk <- struct{}{}:
				request.granted = true
				close(request.done)
				granted = true
			default:
				<-p.prepareSlots
			}
		default:
		}
		if !granted {
			remaining = append(remaining, request)
		}
	}
	clear(p.admissionQueue[len(remaining):])
	p.admissionQueue = remaining
}

func (p *Pipeline) admitPreparation(ctx context.Context, root string) (func(), func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	disk := p.disks[root]
	if disk == nil {
		return nil, nil, errors.New("SOURCE_DISK_NOT_BOUND")
	}
	at := time.Now()
	defer func() { p.admissionNanos.Add(time.Since(at).Nanoseconds()) }()
	request := &preparationRequest{ctx: ctx, disk: disk, done: make(chan struct{})}
	p.admissionMu.Lock()
	p.admissionQueue = append(p.admissionQueue, request)
	p.dispatchPreparation()
	p.admissionMu.Unlock()
	select {
	case <-request.done:
		if request.err != nil {
			return nil, nil, request.err
		}
	case <-ctx.Done():
		p.admissionMu.Lock()
		if request.granted {
			<-disk
			<-p.prepareSlots
		} else if request.err == nil {
			// Cancellation must not wait for a future capacity release. Remove
			// exactly this request, preserving the order of all other waiters.
			for i, pending := range p.admissionQueue {
				if pending == request {
					request.err = ctx.Err()
					copy(p.admissionQueue[i:], p.admissionQueue[i+1:])
					p.admissionQueue[len(p.admissionQueue)-1] = nil
					p.admissionQueue = p.admissionQueue[:len(p.admissionQueue)-1]
					close(request.done)
					break
				}
			}
		}
		p.dispatchPreparation()
		p.admissionMu.Unlock()
		return nil, nil, ctx.Err()
	}
	var diskOnce, slotOnce sync.Once
	releaseDisk := func() {
		diskOnce.Do(func() {
			p.admissionMu.Lock()
			<-disk
			p.dispatchPreparation()
			p.admissionMu.Unlock()
		})
	}
	releaseSlot := func() {
		slotOnce.Do(func() {
			p.admissionMu.Lock()
			<-p.prepareSlots
			p.dispatchPreparation()
			p.admissionMu.Unlock()
		})
	}
	return releaseDisk, releaseSlot, nil
}
