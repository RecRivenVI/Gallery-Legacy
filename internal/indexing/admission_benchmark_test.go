package indexing

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Reproduce the old two-step reservation independently of real filesystem data.
func deviceFirstAdmission(p *Pipeline, ctx context.Context, root string) (func(), func(), error) {
	release, err := p.disk(ctx, root)
	if err != nil {
		return nil, nil, err
	}
	var once sync.Once
	disk := func() { once.Do(release) }
	select {
	case p.prepareSlots <- struct{}{}:
		return disk, func() { <-p.prepareSlots }, nil
	case <-ctx.Done():
		disk()
		return nil, nil, ctx.Err()
	}
}

// Bookkeeping only: no filesystem reads. Compare overhead, not scan throughput.
func BenchmarkPreparationAdmissionCost(b *testing.B) {
	for _, policy := range []string{"global-first", "device-first", "joint"} {
		b.Run(policy, func(b *testing.B) {
			p := Pipeline{disks: map[string]chan struct{}{"slow": make(chan struct{}, 2), "fast": make(chan struct{}, 32)}, prepareSlots: make(chan struct{}, 8)}
			var sequence atomic.Int64
			b.ReportAllocs()
			b.SetParallelism(2)
			b.RunParallel(func(pb *testing.PB) {
				root := "fast"
				if sequence.Add(1)%3 == 0 {
					root = "slow"
				}
				for pb.Next() {
					var disk, slot func()
					switch policy {
					case "joint":
						var e error
						disk, slot, e = p.admitPreparation(context.Background(), root)
						if e != nil {
							b.Fatal(e)
						}
					default:
						ch := p.disks[root]
						if policy == "global-first" {
							p.prepareSlots <- struct{}{}
							ch <- struct{}{}
						} else {
							ch <- struct{}{}
							p.prepareSlots <- struct{}{}
						}
						var diskOnce, slotOnce sync.Once
						disk = func() { diskOnce.Do(func() { <-ch }) }
						slot = func() { slotOnce.Do(func() { <-p.prepareSlots }) }
					}
					disk()
					slot()
				}
			})
			if len(p.prepareSlots) != 0 || len(p.disks["slow"]) != 0 || len(p.disks["fast"]) != 0 || len(p.admissionQueue) != 0 {
				b.Fatal("permit leak")
			}
		})
	}
}

func BenchmarkAdmissionDeviceReservation(b *testing.B) {
	for _, old := range []bool{true, false} {
		name := "current"
		if old {
			name = "device-first"
		}
		b.Run(name, func(b *testing.B) {
			var latency time.Duration
			for n := 0; n < b.N; n++ {
				p := Pipeline{disks: map[string]chan struct{}{"slow": make(chan struct{}, 1), "fast": make(chan struct{}, 1)}, prepareSlots: make(chan struct{}, 1)}
				disk, slot, err := p.admitPreparation(context.Background(), "fast")
				if err != nil {
					b.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				done := make(chan error, 1)
				go func() {
					admit := (*Pipeline).admitPreparation
					if old {
						admit = deviceFirstAdmission
					}
					d, s, e := admit(&p, ctx, "slow")
					if e == nil {
						time.Sleep(8 * time.Millisecond)
						d()
						s()
					}
					done <- e
				}()
				time.Sleep(10 * time.Millisecond)
				go func() { time.Sleep(30 * time.Millisecond); disk(); slot() }()
				at := time.Now()
				release, err := p.disk(ctx, "slow")
				latency += time.Since(at)
				if err != nil {
					b.Fatal(err)
				}
				release()
				if err = <-done; err != nil {
					b.Fatal(err)
				}
				cancel()
			}
			b.ReportMetric(float64(latency.Nanoseconds())/float64(b.N)/1e6, "discovery-wait-ms/op")
		})
	}
}
