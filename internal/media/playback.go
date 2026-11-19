package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

const (
	playbackBytes = 16 << 20
	playbackTime  = 30 * time.Second
)

var errPlaybackLimit = errors.New("compatibility video exceeds duration or byte limit")
var errPlaybackTool = errors.New("FFmpeg with H.264 encoding is unavailable")

func (s *Service) ServeCompatibleVideo(w http.ResponseWriter, r *http.Request, f File) error {
	if f.Platform != "pixiv" || f.Kind != "video" || !strings.EqualFold(filepath.Ext(f.Path), ".webm") {
		return Failure("VIDEO_COMPAT_UNAVAILABLE", http.StatusUnsupportedMediaType)
	}
	if f.Info.Size() > playbackBytes {
		return Failure("VIDEO_COMPAT_LIMIT", http.StatusUnprocessableEntity)
	}
	if !s.playback.TryLock() {
		return Failure("VIDEO_COMPAT_BUSY", http.StatusServiceUnavailable)
	}
	defer s.playback.Unlock()
	video, err := encodeCompatibleVideo(r.Context(), s.Cache.ffmpeg, f)
	if errors.Is(err, errPlaybackLimit) {
		return Failure("VIDEO_COMPAT_LIMIT", http.StatusUnprocessableEntity)
	}
	if errors.Is(err, errPlaybackTool) {
		return Failure("VIDEO_COMPAT_TOOL_UNAVAILABLE", http.StatusServiceUnavailable)
	}
	if err != nil {
		slog.WarnContext(r.Context(), "兼容视频生成失败", "mediaId", f.MediaID, "error", err)
		return Failure("VIDEO_COMPAT_FAILED", http.StatusUnprocessableEntity)
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Content-Length", strconv.Itoa(len(video.data)))
	if video.silent {
		w.Header().Set("X-Gallery-Video-Silent", "true")
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(video.data)
	if err != nil {
		return fmt.Errorf("write compatibility video: %w", err)
	}
	return nil
}

type compatibleVideo struct {
	data   []byte
	silent bool
}

func encodeCompatibleVideo(ctx context.Context, command string, f File) (compatibleVideo, error) {
	if err := library.NoLinks(f.Path); err != nil {
		return compatibleVideo{}, fmt.Errorf("verify compatibility source: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	if command == "" {
		command = "ffmpeg"
	}
	var output playbackBuffer
	var progress bytes.Buffer
	// Leave time beyond the accepted duration so the encoder cap cannot turn
	// an overlong source into an apparently successful short video.
	limit := strconv.FormatInt(int64((playbackTime+time.Second)/time.Second), 10)
	cmd := exec.CommandContext(ctx, command, "-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:2", "-nostdin",
		"-protocol_whitelist", "file,pipe", "-f", "matroska", "-threads", "2", "-max_pixels", "8294400", "-i", f.Path,
		"-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-t", limit,
		"-vf", "scale=iw:ih:out_range=tv,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p", "-color_range", "tv", "-filter_threads", "1",
		"-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads:v", "2", "-bf", "0",
		"-c:a", "aac", "-b:a", "128k", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Stdout, cmd.Stderr = &output, &progress
	if err := cmd.Run(); err != nil {
		if output.exceeded {
			return compatibleVideo{}, errPlaybackLimit
		}
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) ||
			strings.Contains(progress.String(), "Unknown encoder 'libx264'") {
			return compatibleVideo{}, fmt.Errorf("%w: %w", errPlaybackTool, err)
		}
		return compatibleVideo{}, fmt.Errorf("encode compatibility video: %w", err)
	}
	info := progress.String()
	duration := playbackDuration(info)
	if duration > playbackTime || sourceVideoDuration(info) > playbackTime {
		return compatibleVideo{}, errPlaybackLimit
	}
	if output.buffer.Len() == 0 || duration <= 0 || sourceVideoDuration(info) <= 0 {
		return compatibleVideo{}, errors.New("encoder returned no playable frames")
	}
	after, err := os.Lstat(f.Path)
	if err != nil {
		return compatibleVideo{}, fmt.Errorf("recheck compatibility source: %w", err)
	}
	if !os.SameFile(f.Info, after) || after.Size() != f.Info.Size() || !after.ModTime().Equal(f.Info.ModTime()) {
		return compatibleVideo{}, errors.New("compatibility source changed while encoding")
	}
	_, outputInfo, hasOutput := strings.Cut(info, "Output #0, mp4,")
	silent := hasOutput && strings.Contains(outputInfo, "Video: h264") && !strings.Contains(outputInfo, "Audio:")
	return compatibleVideo{data: output.buffer.Bytes(), silent: silent}, nil
}

func playbackDuration(progress string) time.Duration {
	var duration time.Duration
	for _, line := range strings.Split(progress, "\n") {
		if value, ok := strings.CutPrefix(line, "out_time_us="); ok {
			microseconds, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
			if err == nil {
				duration = max(duration, time.Duration(microseconds)*time.Microsecond)
			}
		}
	}
	return duration
}

type playbackBuffer struct {
	buffer   bytes.Buffer
	exceeded bool
}

func (b *playbackBuffer) Write(p []byte) (int, error) {
	if len(p) > playbackBytes-b.buffer.Len() {
		b.exceeded = true
		return 0, errPlaybackLimit
	}
	return b.buffer.Write(p)
}
