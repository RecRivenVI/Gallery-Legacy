package media

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
)

type job struct {
	file   File
	target string
	done   chan struct{}
	err    error
}
type Cache struct {
	root, temp string
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	ready      *sync.Cond
	queue      []*job
	pending    map[string]*job
	workers    sync.WaitGroup
	render     func(File, string) error
}

func NewCache(config instance.Config) (*Cache, error) {
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
	ctx, cancel := context.WithCancel(context.Background())
	c := &Cache{root: root, temp: config.TempRoot, ctx: ctx, cancel: cancel, pending: map[string]*job{}}
	c.ready = sync.NewCond(&c.mu)
	c.render = c.generate
	for range 4 {
		c.workers.Go(c.work)
	}
	return c, nil
}
func CacheKey(f File) (string, error) {
	b, err := protocol.JSON([]string{"v2", f.Platform, protocol.Lower(filepath.Clean(f.Path)), f.WorkID, f.MediaID, f.RelativeKey, strconv.FormatInt(f.Info.Size(), 10), strconv.FormatInt(f.Info.ModTime().UnixNano(), 10)})
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}
func validCache(path string) bool {
	s, err := os.Lstat(path)
	return err == nil && s.Mode().IsRegular() && s.Size() > 0
}
func (c *Cache) Thumbnail(ctx context.Context, f File) (File, string, error) {
	key, err := CacheKey(f)
	if err != nil {
		return File{}, "", err
	}
	target := filepath.Join(c.root, key[:2], key+".webp")
	if err = library.NoLinks(target); err != nil {
		return File{}, "", err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return File{}, "", err
	}
	c.mu.Lock()
	if c.ctx.Err() != nil {
		c.mu.Unlock()
		return File{}, "", fmt.Errorf("Thumbnail service is closed")
	}
	ref := target + ".json"
	if err = library.NoLinks(ref); err != nil {
		c.mu.Unlock()
		return File{}, "", err
	}
	if _, err = os.Stat(ref); os.IsNotExist(err) {
		e := instance.WriteJSON(ref, map[string]any{"version": 1, "source": f.Path, "size": strconv.FormatInt(f.Info.Size(), 10), "mtimeNs": strconv.FormatInt(f.Info.ModTime().UnixNano(), 10)})
		if e != nil {
			c.mu.Unlock()
			return File{}, "", e
		}
	}
	if validCache(target) {
		c.mu.Unlock()
		st, e := os.Stat(target)
		return File{Path: target, Info: st}, "hit", e
	}
	j := c.pending[target]
	if j == nil {
		j = &job{file: f, target: target, done: make(chan struct{})}
		c.pending[target] = j
		c.queue = append(c.queue, j)
		c.ready.Signal()
	}
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return File{}, "", ctx.Err()
	case <-j.done:
	}
	if j.err != nil {
		return File{}, "", j.err
	}
	st, err := os.Stat(target)
	return File{Path: target, Info: st}, "generated", err
}
func (c *Cache) work() {
	for {
		c.mu.Lock()
		for len(c.queue) == 0 && c.ctx.Err() == nil {
			c.ready.Wait()
		}
		if c.ctx.Err() != nil {
			c.mu.Unlock()
			return
		}
		j := c.queue[0]
		c.queue = c.queue[1:]
		render := c.render
		c.mu.Unlock()
		err := render(j.file, j.target)
		c.mu.Lock()
		j.err = err
		delete(c.pending, j.target)
		close(j.done)
		c.mu.Unlock()
	}
}
func (c *Cache) generate(f File, target string) error {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	temp := target + "." + strconv.Itoa(os.Getpid()) + "." + hex.EncodeToString(random[:]) + ".tmp"
	defer func() {
		if _, err := os.Lstat(temp); err == nil {
			if err = instance.Recycle(temp); err != nil {
				slog.Error("thumbnail temporary cleanup", "error", err)
			}
		}
	}()
	command, args, timeout := "magick", []string{f.Path + "[0]", "-auto-orient", "-thumbnail", "512x512>", "-strip", "-quality", "82", "webp:" + temp}, 20*time.Second
	if f.Kind == "video" {
		command = "ffmpeg"
		timeout = 30 * time.Second
		args = []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-i", f.Path, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease", "-an", "-c:v", "libwebp", "-quality", "82", "-f", "image2", temp}
	}
	ctx, cancel := context.WithTimeout(c.ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Env = append(os.Environ(), "TEMP="+c.temp, "TMP="+c.temp, "MAGICK_TEMPORARY_PATH="+c.temp)
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("RUNTIME_THUMBNAIL_TIMEOUT: %w", ctx.Err())
		}
		return fmt.Errorf("RUNTIME_THUMBNAIL_GENERATION_FAILED: %w", err)
	}
	st, err := os.Lstat(temp)
	if err != nil || !st.Mode().IsRegular() || st.Size() == 0 {
		return fmt.Errorf("RUNTIME_THUMBNAIL_OUTPUT_INVALID")
	}
	after, err := os.Lstat(f.Path)
	if err != nil || !after.Mode().IsRegular() || after.Size() != f.Info.Size() || !after.ModTime().Equal(f.Info.ModTime()) {
		return fmt.Errorf("RUNTIME_THUMBNAIL_SOURCE_CHANGED")
	}
	if validCache(target) {
		return nil
	}
	return os.Rename(temp, target)
}
func (c *Cache) Close() error {
	c.mu.Lock()
	c.cancel()
	for _, j := range c.queue {
		j.err = fmt.Errorf("Thumbnail service is closed")
		delete(c.pending, j.target)
		close(j.done)
	}
	c.queue = nil
	c.ready.Broadcast()
	c.mu.Unlock()
	c.workers.Wait()
	return nil
}
