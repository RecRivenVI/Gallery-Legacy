package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/task"
)

func main() {
	root := flag.String("root", "", "new external synthetic root")
	port := flag.Int("port", 18420, "isolated loopback port")
	count := flag.Int("works", 144, "synthetic works per platform")
	video := flag.String("video-encoder", "", "optional FFmpeg executable for synthetic videos")
	upgrade := flag.Bool("upgrade", false, "upgrade an existing marked synthetic fixture without scanning")
	flag.Parse()
	if *upgrade {
		if err := upgradeFixture(*root); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := generate(*root, *port, *count); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if *count > 0 {
		if err := addMotion(*root, *video); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}

func upgradeFixture(root string) error {
	var marker struct{ Kind string }
	raw, err := os.ReadFile(filepath.Join(root, ".gallery-synthetic.json"))
	if err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &marker); err != nil {
		return err
	}
	if marker.Kind != "gallery-synthetic" {
		return fmt.Errorf("SYNTHETIC_ONLY")
	}
	c, err := instance.Load(filepath.Join(root, "instance/config.json"))
	if err != nil {
		return err
	}
	for _, source := range c.Sources {
		relative, err := filepath.Rel(filepath.Join(root, "sources"), source)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
			return fmt.Errorf("SYNTHETIC_ONLY")
		}
	}
	if err = task.Layout(c); err != nil {
		return err
	}
	return task.Prepare(context.Background(), c)
}

func addMotion(root, encoder string) error {
	dir := filepath.Join(root, "sources", "pixiv", "700", "2026-01-02_00-00-00_0002")
	if _, err := os.Stat(dir); err != nil {
		return nil
	}
	frames := &gif.GIF{LoopCount: 0}
	for i := 0; i < 4; i++ {
		im := image.NewPaletted(image.Rect(0, 0, 320, 240), color.Palette{color.RGBA{32, 72, 128, 255}, color.RGBA{240, 200, 100, 255}})
		draw.Draw(im, image.Rect(20+i*40, 60, 100+i*40, 180), &image.Uniform{im.Palette[1]}, image.Point{}, draw.Src)
		frames.Image = append(frames.Image, im)
		frames.Delay = append(frames.Delay, 15)
	}
	f, err := os.Create(filepath.Join(dir, "animation.gif"))
	if err != nil {
		return err
	}
	err = gif.EncodeAll(f, frames)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if encoder != "" {
		out, err := exec.Command(encoder, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=480x320:rate=24", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", filepath.Join(dir, "video.mp4")).CombinedOutput()
		if err != nil {
			return fmt.Errorf("synthetic video: %w: %s", err, out)
		}
	}
	return nil
}
func generate(root string, port, count int) error {
	if !filepath.IsAbs(root) || port < 1024 || port > 65535 || port == 8081 || count < 0 {
		return fmt.Errorf("explicit isolated root and port required")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		return fmt.Errorf("new synthetic root required")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	def, err := api.LoadCatalog()
	if err != nil {
		return err
	}
	sources := map[string]string{}
	for platformIndex, platform := range def.Platforms {
		source := filepath.Join(root, "sources", platform.ID)
		sources[platform.ID] = source
		if err := os.MkdirAll(source, 0700); err != nil {
			return err
		}
		for i := 0; i < count; i++ {
			author := "700"
			if platform.ID == "Pawchive" {
				author = "patreon_700"
			}
			if platform.ID == "Gank" {
				author = "12345678-abcd-4abc-8abc-0123456789ab"
			}
			if platform.ID == "Venera" {
				author = "Synthetic book"
			}
			dir := filepath.Join(source, author, fmt.Sprintf("2026-01-%02d_00-00-00_%04d", i%28+1, i+1))
			if err := os.MkdirAll(dir, 0700); err != nil {
				return err
			}
			pages := 1
			if i == 0 {
				pages = 48
			}
			if i == 1 {
				pages = 3
			}
			for page := 0; page < pages; page++ {
				if err := writeImage(filepath.Join(dir, fmt.Sprintf("%03d.png", page+1)), platformIndex*1000+i, page); err != nil {
					return err
				}
			}
			metadata := map[string]any{"id": fmt.Sprint(i + 1), "title": fmt.Sprintf("Abstract Study A%06d · 合成作品 🌈", platformIndex*1000+i), "description": "合成几何图案\nhttps://example.invalid/gallery\n<b>&\"' 作为普通文字", "caption": "合成几何图案\nhttps://example.invalid/gallery\n<b>&\"' 作为普通文字", "tags": []string{"synthetic", "几何", strings.Repeat("长标签", 8)}, "user": map[string]any{"id": "700", "name": "Synthetic Author"}, "authorName": "Synthetic Author"}
			if platform.ID == "pixiv" {
				metadata["type"] = "illust"
				metadata["x_restrict"] = i % 3
				metadata["total_bookmarks"] = i * 10
				metadata["total_view"] = i * 100
				if i == 0 || i == 2 || i == 3 {
					metadata["type"] = "manga"
					metadata["series"] = map[string]any{"id": "42", "title": "合成连载"}
				}
			}
			if platform.ID == "pixivFANBOX" {
				metadata["type"] = "image"
				metadata["feeRequired"] = i % 2 * 500
				metadata["user"].(map[string]any)["userId"] = "700"
				metadata["user"].(map[string]any)["profileLinks"] = []string{"https://x.com/synthetic-reader"}
			}
			if platform.ID == "X" {
				metadata["user"].(map[string]any)["id"] = "800"
				metadata["user"].(map[string]any)["nick"] = "synthetic-reader"
			}
			metadata["date"] = fmt.Sprintf("2026-01-%02dT00:00:00Z", i%28+1)
			bytes, err := json.Marshal(metadata)
			if err != nil {
				return err
			}
			if err = os.WriteFile(filepath.Join(dir, "metadata.json"), bytes, 0600); err != nil {
				return err
			}
		}
	}
	instance := filepath.Join(root, "instance")
	if err := catalog.CreateLive(context.Background(), instance, sources); err != nil {
		return err
	}
	config := map[string]any{"instanceRoot": instance, "deployment": "staging", "mode": "local", "listenAddress": "127.0.0.1", "port": port, "sources": sources, "liveUpdates": true, "fileBrowserRoots": []map[string]string{{"id": "synthetic", "name": "合成文件", "path": filepath.Join(root, "files")}}, "shortLinks": map[string]string{}, "retention": map[string]bool{"enabled": false}}
	if err := os.MkdirAll(filepath.Join(root, "files", "Unicode folder"), 0700); err != nil {
		return err
	}
	if err := writeImage(filepath.Join(root, "files", "Unicode folder", "1.png"), 99, 0); err != nil {
		return err
	}
	bytes, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(instance, "config.json"), bytes, 0600); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(root, ".gallery-synthetic.json"), []byte(`{"kind":"gallery-synthetic","seed":20261025}`+"\n"), 0600); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"config": filepath.Join(instance, "config.json"), "seed": filepath.Join(instance, "live", "catalog.sqlite"), "works": count * len(def.Platforms)})
}
func writeImage(path string, id, page int) error {
	w, h := 480, 480
	if id%5 == 1 {
		w, h = 320, 640
	}
	if id%5 == 2 {
		w, h = 640, 320
	}
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			im.SetRGBA(x, y, color.RGBA{uint8((id*53 + x/3) % 256), uint8((page*61 + y/3 + 90) % 256), uint8((id*17 + (x+y)/5 + 50) % 256), 255})
		}
	}
	draw.Draw(im, image.Rect(w/4, h/4, w*3/4, h*3/4), &image.Uniform{color.NRGBA{240, 240, 240, 210}}, image.Point{}, draw.Over)
	// A source-generated seven-segment identifier stays legible in thumbnails.
	text := fmt.Sprintf("%06d", id)
	segments := []int{63, 6, 91, 79, 102, 109, 125, 7, 127, 111}
	for index, char := range text {
		mask := segments[char-'0']
		x := w/2 - 102 + index*34
		y := h/2 - 30
		rects := []image.Rectangle{image.Rect(x+4, y, x+24, y+4), image.Rect(x+24, y+4, x+28, y+27), image.Rect(x+24, y+31, x+28, y+54), image.Rect(x+4, y+54, x+24, y+58), image.Rect(x, y+31, x+4, y+54), image.Rect(x, y+4, x+4, y+27), image.Rect(x+4, y+27, x+24, y+31)}
		for bit, rect := range rects {
			if mask&(1<<bit) != 0 {
				draw.Draw(im, rect, &image.Uniform{color.RGBA{16, 16, 16, 255}}, image.Point{}, draw.Src)
			}
		}
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	if err = png.Encode(file, im); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}
