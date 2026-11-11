package media

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
	entry                   thumbnailEntry
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
	writes                     chan thumbnailWrite
	disks                      map[string]int
	workers                    sync.WaitGroup
	index                      *thumbnailIndex
	render                     func(context.Context, File, string, string) (imaging.Preview, error)
	preload                    *coverPreload
	backgroundPaused, scanning bool
	backgroundActive           int
}

func NewCache(config instance.Config, resources string) (*Cache, error) {
	root := config.CacheRoot
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
	index, err := openThumbnailIndex(root)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Cache{root: root, temp: config.TempRoot, ffmpeg: config.FFmpegPath, ctx: ctx, cancel: cancel, index: index, pending: map[string]*job{}, disks: map[string]int{}, writes: make(chan thumbnailWrite, 8)}
	c.ready = sync.NewCond(&c.mu)
	engine := sync.OnceValues(func() (*imaging.Engine, error) { return imaging.Load(filepath.Join(resources, "libvips")) })
	c.render = func(ctx context.Context, f File, target, tier string) (imaging.Preview, error) {
		return c.generate(ctx, engine, f, target, tier)
	}
	for range max(1, min(8, runtime.NumCPU()/2)) {
		c.workers.Go(c.work)
	}
	c.workers.Go(c.writeThumbnails)
	return c, nil
}
func CacheKey(f File) (string, error) { return PreviewKey(f, Display) }

func PreviewKey(f File, tier string) (string, error) {
	if tier != Display && tier != Strip {
		return "", Failure("INVALID_INPUT", 400)
	}
	relative, err := filepath.Rel(f.Root, f.Path)
	if err != nil {
		return "", err
	}
	if !library.Inside(f.Root, f.Path) {
		return "", fmt.Errorf("RUNTIME_THUMBNAIL_SOURCE_OUTSIDE_ROOT")
	}
	return imaging.Key(f.Platform, relative, f.Info.Size(), f.Info.ModTime().UnixNano()), nil
}

func (c *Cache) Thumbnail(ctx context.Context, f File) (File, string, error) {
	return c.Request(ctx, f, Display, Visible)
}

func (c *Cache) Request(ctx context.Context, f File, tier string, priority Priority) (File, string, error) {
	if err := ctx.Err(); err != nil {
		return File{}, "", err
	}
	if f.Cover {
		tier = Display
	}
	key, err := PreviewKey(f, tier)
	if err != nil {
		return File{}, "", err
	}
	for {
		entry, state, err := c.request(ctx, f, key, tier, priority)
		if err != nil {
			return File{}, "", err
		}
		if state != "" {
			f.preview = &entry
			return f, state, nil
		}
	}
}

func (c *Cache) request(ctx context.Context, f File, key, tier string, priority Priority) (thumbnailEntry, string, error) {
	var zero thumbnailEntry
	c.mu.Lock()
	if c.ctx.Err() != nil {
		c.mu.Unlock()
		return zero, "", c.ctx.Err()
	}
	j := c.pending[key]
	if j == nil {
		entry, err := c.cached(ctx, f, key, targetShort(tier))
		if err != nil {
			c.mu.Unlock()
			return zero, "", err
		}
		if entry.Data != nil {
			c.mu.Unlock()
			return entry, "hit", nil
		}
		disk, _ := library.Disk(f.Root)
		j = &job{file: f, key: key, target: filepath.Join(c.temp, "thumbnail-"+key+".webp"), tier: tier, disk: disk, priority: priority, done: make(chan struct{})}
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
		return zero, "", ctx.Err()
	case <-j.done:
	}
	if j.err != nil {
		return zero, "", j.err
	}
	if j.file.Cover != f.Cover || j.entry.Short < targetShort(tier) {
		return zero, "", nil
	}
	return j.entry, "generated", nil
}

func (c *Cache) cached(ctx context.Context, f File, key string, minimum int) (thumbnailEntry, error) {
	entry, ok, err := c.index.lookup(ctx, key, f.Cover, true)
	if err != nil {
		return entry, err
	}
	if !ok || entry.Short < minimum {
		other, found, err := c.index.lookup(ctx, key, !f.Cover, true)
		if err != nil {
			return other, err
		}
		if !found || other.Short < minimum {
			return thumbnailEntry{}, nil
		}
		if err = c.index.move(ctx, key, f.Cover); err != nil {
			return other, err
		}
		if !f.Cover {
			if err = c.index.evict(ctx); err != nil {
				return other, err
			}
		}
		entry = other
	}
	relative, err := filepath.Rel(f.Root, f.Path)
	if err != nil {
		return entry, err
	}
	if err = c.index.retire(ctx, key, f.Platform, strings.ToLower(filepath.ToSlash(relative)), f.Cover); err != nil {
		return entry, err
	}
	if !f.Cover {
		err = c.index.touch(ctx, key)
	}
	return entry, err
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
		entry := thumbnailEntry{DurationMs: result.DurationMs, Width: result.Width, Height: result.Height, Hash: result.Hash, Animated: result.Animated, Short: targetShort(j.tier)}
		if err == nil {
			entry.Data, err = os.ReadFile(j.target)
		}
		removeTemporary(j.target)
		if err == nil {
			err = c.persistThumbnail(j, result, entry.Data)
		}
		if err == nil && !j.file.Cover {
			if evictErr := c.index.evict(c.ctx); evictErr != nil && c.ctx.Err() == nil {
				slog.Warn("缩略图缓存清理失败", "error", evictErr)
			}
		}
		c.mu.Lock()
		j.entry, j.err = entry, err
		delete(c.pending, j.key)
		c.disks[j.disk]--
		if j.backgroundLease {
			c.backgroundActive--
		}
		close(j.done)
		c.ready.Broadcast()
		c.mu.Unlock()
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
