package media

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type Priority int

const (
	Visible Priority = iota
	Nearby
	Background
)

type job struct {
	file                    File
	key, target, tier, disk string
	priority                Priority
	done                    chan struct{}
	err                     error
	result                  imaging.Preview
	waiters                 int
	running                 bool
	backgroundLease         bool
}
type Cache struct {
	root, temp, ffmpeg         string
	ctx                        context.Context
	cancel                     context.CancelFunc
	mu                         sync.Mutex
	ready                      *sync.Cond
	queue                      []*job
	pending                    map[string]*job
	disks                      map[string]int
	retained                   map[string]int
	workers                    sync.WaitGroup
	index                      *thumbnailIndex
	render                     func(context.Context, File, string, string) (imaging.Preview, error)
	preload                    *coverPreload
	backgroundPaused, scanning bool
	backgroundActive           int
}

func NewCache(config instance.Config, resources string) (*Cache, error) {
	root := filepath.Join(config.CacheRoot, "thumbnails")
	for _, p := range []string{root, config.TempRoot} {
		if !library.Inside(config.InstanceRoot, p) {
			return nil, fmt.Errorf("RUNTIME_THUMBNAIL_PATH_OUTSIDE_ROOT")
		}
		if err := library.NoLinks(p); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(p, 0700); err != nil {
			return nil, err
		}
	}
	index, err := openThumbnailIndex(filepath.Join(config.CacheRoot, "thumbs.db"))
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Cache{root: root, temp: config.TempRoot, ffmpeg: config.FFmpegPath, ctx: ctx, cancel: cancel, index: index, pending: map[string]*job{}, disks: map[string]int{}, retained: map[string]int{}}
	c.index.limit = config.ThumbnailCacheBytes
	c.ready = sync.NewCond(&c.mu)
	engine := sync.OnceValues(func() (*imaging.Engine, error) { return imaging.Load(filepath.Join(resources, "libvips")) })
	c.render = func(ctx context.Context, f File, target, tier string) (imaging.Preview, error) {
		return c.generate(ctx, engine, f, target, tier)
	}
	for range max(1, min(8, runtime.NumCPU()/2)) {
		c.workers.Go(c.work)
	}
	return c, nil
}
func CacheKey(f File) (string, error) { return PreviewKey(f, "s") }
func PreviewKey(f File, tier string) (string, error) {
	relative, err := filepath.Rel(f.Root, f.Path)
	if err != nil {
		return "", err
	}
	if !library.Inside(f.Root, f.Path) {
		return "", fmt.Errorf("RUNTIME_THUMBNAIL_SOURCE_OUTSIDE_ROOT")
	}
	return imaging.Key(f.Platform, relative, f.Info.Size(), f.Info.ModTime().UnixNano(), tier), nil
}
func (c *Cache) Thumbnail(ctx context.Context, f File) (File, string, error) {
	return c.Request(ctx, f, "s", Visible)
}
func (c *Cache) Request(ctx context.Context, f File, tier string, priority Priority) (output File, state string, resultErr error) {
	if err := ctx.Err(); err != nil {
		return File{}, "", err
	}
	if tier != "s" && tier != "m" && tier != "l" {
		return File{}, "", Failure("INVALID_INPUT", 400)
	}
	key, err := PreviewKey(f, tier)
	if err != nil {
		return File{}, "", err
	}
	if tier != "s" {
		release := c.retain(key)
		defer func() {
			if resultErr != nil {
				release()
			} else {
				output.release = release
			}
		}()
	}
	// Lookup and pending registration share one lock with job completion.
	// Otherwise a request can miss the index just before completion, then
	// enqueue a second render after that job has left pending.
	c.mu.Lock()
	if c.ctx.Err() != nil {
		c.mu.Unlock()
		return File{}, "", c.ctx.Err()
	}
	if cached, ok, err := c.index.lookup(ctx, key); err != nil {
		c.mu.Unlock()
		return File{}, "", err
	} else if ok {
		result, err := c.cachedFile(f, key, cached)
		if err == nil {
			c.mu.Unlock()
			return result, "hit", nil
		}
		if !os.IsNotExist(err) {
			c.mu.Unlock()
			return File{}, "", err
		}
	}
	target := filepath.Join(c.root, key[:2], key[2:4], key+".webp")
	disk, _ := library.Disk(f.Root)
	j := c.pending[key]
	if j == nil {
		j = &job{file: f, key: key, target: target, tier: tier, disk: disk, priority: priority, done: make(chan struct{})}
		c.pending[key] = j
		c.queue = append(c.queue, j)
	}
	if priority < j.priority {
		j.priority = priority
	}
	j.waiters++
	c.ready.Broadcast()
	c.mu.Unlock()
	defer c.release(j)
	select {
	case <-ctx.Done():
		return File{}, "", ctx.Err()
	case <-j.done:
	}
	if j.err != nil {
		return File{}, "", j.err
	}
	if j.result.Original {
		return f, "original", nil
	}
	st, err := os.Stat(j.target)
	return File{Path: j.target, Info: st}, "generated", err
}
func (c *Cache) cachedFile(source File, key string, entry thumbnailEntry) (File, error) {
	if entry.Original {
		return source, nil
	}
	target := filepath.Join(c.root, key[:2], key[2:4], key+".webp")
	if err := library.NoLinks(target); err != nil {
		return File{}, err
	}
	st, err := os.Stat(target)
	return File{Path: target, Info: st}, err
}
func (c *Cache) release(j *job) {
	c.mu.Lock()
	defer c.mu.Unlock()
	j.waiters--
	if j.waiters == 0 && !j.running {
		for i, candidate := range c.queue {
			if candidate == j {
				c.queue = append(c.queue[:i], c.queue[i+1:]...)
				delete(c.pending, j.key)
				j.err = context.Canceled
				close(j.done)
				break
			}
		}
	}
}
func (c *Cache) next() *job {
	best := -1
	for i, j := range c.queue {
		if j.priority == Background && (c.backgroundPaused || c.scanning) {
			continue
		}
		if c.disks[j.disk] < 2 && (best < 0 || j.priority < c.queue[best].priority) {
			best = i
		}
	}
	if best < 0 {
		return nil
	}
	j := c.queue[best]
	c.queue = append(c.queue[:best], c.queue[best+1:]...)
	j.running = true
	j.backgroundLease = j.priority == Background
	if j.backgroundLease {
		c.backgroundActive++
	}
	c.disks[j.disk]++
	return j
}
func (c *Cache) work() {
	for {
		c.mu.Lock()
		var j *job
		for c.ctx.Err() == nil {
			j = c.next()
			if j != nil {
				break
			}
			c.ready.Wait()
		}
		if c.ctx.Err() != nil {
			c.mu.Unlock()
			return
		}
		render := c.render
		c.mu.Unlock()
		result, err := render(c.ctx, j.file, j.target, j.tier)
		if err == nil {
			err = c.index.store(c.ctx, j, result)
		}
		c.mu.Lock()
		j.result, j.err = result, err
		delete(c.pending, j.key)
		c.disks[j.disk]--
		if j.backgroundLease {
			c.backgroundActive--
		}
		close(j.done)
		c.ready.Broadcast()
		c.mu.Unlock()
		if err == nil && j.tier != "s" {
			if err = c.evict(j.key); err != nil {
				slog.Warn("缩略图缓存清理失败", "error", err)
			}
		}
	}
}
func (c *Cache) Close() error {
	c.mu.Lock()
	c.cancel()
	for _, j := range c.queue {
		j.err = context.Canceled
		delete(c.pending, j.key)
		close(j.done)
	}
	c.queue = nil
	c.ready.Broadcast()
	c.mu.Unlock()
	c.workers.Wait()
	return c.index.db.Close()
}
