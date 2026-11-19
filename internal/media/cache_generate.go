package media

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/imaging"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

func (c *Cache) generate(ctx context.Context, engine func() (*imaging.Engine, error), f File, target, tier string) (imaging.Preview, error) {
	var zero imaging.Preview
	if err := library.NoLinks(target); err != nil {
		return zero, err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return zero, err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return zero, err
	}
	temp := target + "." + hex.EncodeToString(random[:]) + ".tmp"
	defer removeTemporary(temp)
	duration := int64(0)
	input := f.Path
	if f.Kind == "video" {
		input = filepath.Join(c.temp, "video-"+hex.EncodeToString(random[:])+".png")
		defer removeTemporary(input)
		command := c.ffmpeg
		if command == "" {
			command = "ffmpeg"
		}
		cmd := exec.CommandContext(ctx, command, "-hide_banner", "-loglevel", "info", "-nostdin", "-i", f.Path, "-map", "0:v:0", "-frames:v", "1", "-an", input)
		var info bytes.Buffer
		cmd.Stderr = &info
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Run(); err != nil {
			return zero, fmt.Errorf("video thumbnail: %w", err)
		}
		duration = sourceVideoDuration(info.String()).Round(time.Millisecond).Milliseconds()
	}
	e, err := engine()
	if err != nil {
		return zero, fmt.Errorf("%w: %w", errThumbnailEngine, err)
	}
	preview, err := e.Render(input, temp, tier, true)
	if err != nil {
		return zero, fmt.Errorf("render thumbnail: %w", err)
	}
	preview.DurationMs = duration
	if err = ctx.Err(); err != nil {
		return zero, err
	}
	after, err := os.Lstat(f.Path)
	if err != nil {
		return zero, fmt.Errorf("verify thumbnail source: %w", err)
	}
	if !after.Mode().IsRegular() || after.Size() != f.Info.Size() || !after.ModTime().Equal(f.Info.ModTime()) {
		return zero, fmt.Errorf("RUNTIME_THUMBNAIL_SOURCE_CHANGED")
	}
	if !preview.Original {
		if err = os.Rename(temp, target); err != nil {
			return zero, fmt.Errorf("install thumbnail: %w", err)
		}
	}
	return preview, nil
}

var sourceDurationPattern = regexp.MustCompile(`Duration: (\d+):(\d+):(\d+(?:\.\d+)?)`)

func sourceVideoDuration(info string) time.Duration {
	match := sourceDurationPattern.FindStringSubmatch(info)
	if len(match) != 4 {
		return 0
	}
	hours, _ := strconv.ParseFloat(match[1], 64)
	minutes, _ := strconv.ParseFloat(match[2], 64)
	seconds, _ := strconv.ParseFloat(match[3], 64)
	return time.Duration((hours*3600 + minutes*60 + seconds) * float64(time.Second))
}
func removeTemporary(file string) {
	if _, err := os.Lstat(file); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			slog.Warn("读取缩略图临时文件失败", "error", err)
		}
		return
	}
	if err := instance.RemoveOwned(file); err != nil {
		slog.Warn("缩略图临时文件未能删除", "error", err)
	}
}
