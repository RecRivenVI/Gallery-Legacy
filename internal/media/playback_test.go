package media

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
)

func TestCompatibilityVideoFullClipAndDurationLimit(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg is needed to synthesize a WebM input")
	}
	for _, tc := range []struct {
		duration string
		wantCode string
		audio    bool
	}{
		{"1.25", "", false},
		{"1.25", "", true},
		{"33", "VIDEO_COMPAT_LIMIT", false},
	} {
		t.Run(fmt.Sprintf("%s/audio=%t", tc.duration, tc.audio), func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "synthetic.webm")
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			args := []string{"-hide_banner", "-loglevel", "error", "-nostdin",
				"-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=128x96:rate=12:duration=%s", tc.duration)}
			if tc.audio {
				args = append(args, "-f", "lavfi", "-i", "sine=frequency=880:duration=1.25", "-c:a", "libopus")
			}
			cmd := exec.CommandContext(ctx, ffmpeg, append(args,
				"-c:v", "libvpx-vp9", "-threads", "2", "-deadline", "realtime", file)...)
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("create synthesized video: %v: %s", err, output)
			}
			info, err := os.Stat(file)
			if err != nil {
				t.Fatal(err)
			}
			service := Service{Cache: &Cache{ffmpeg: ffmpeg}}
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(t.Context())
			err = service.ServeCompatibleVideo(w, r, File{Platform: "pixiv", Kind: "video", Path: file, Info: info})
			if tc.wantCode != "" {
				if e, ok := err.(*protocol.Error); !ok || e.Code != tc.wantCode || w.Body.Len() != 0 {
					t.Fatalf("overlong video must fail without sending a partial MP4, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "video/mp4" {
				t.Fatalf("unexpected compatibility response: %d %s", w.Code, w.Header().Get("Content-Type"))
			}
			if markedSilent := w.Header().Get("X-Gallery-Video-Silent") == "true"; markedSilent == tc.audio {
				t.Fatalf("unexpected silence flag for audio=%t", tc.audio)
			}
			decode := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:1", "-i", "pipe:0", "-f", "null", "-")
			decode.Stdin = bytes.NewReader(w.Body.Bytes())
			output, err := decode.CombinedOutput()
			if err != nil || playbackDuration(string(output)) < 1200*time.Millisecond || !bytes.Contains(output, []byte("frame=15")) {
				t.Fatalf("compatibility stream did not decode every frame: %v: %s", err, output)
			}
		})
	}
}
