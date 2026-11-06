package imaging

import (
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTierGeometry(t *testing.T) {
	for _, test := range []struct {
		w, h         int
		tier         string
		wantW, wantH int
	}{{1600, 1200, "s", 480, 360}, {1200, 6000, "s", 216, 1080}, {1600, 1200, "m", 960, 720}, {4000, 3000, "l", 2048, 1536}, {320, 240, "m", 320, 240}} {
		w, h := Target(test.w, test.h, test.tier)
		if w != test.wantW || h != test.wantH {
			t.Fatalf("%+v: %d %d", test, w, h)
		}
	}
}

func TestSmallAnimationProducesFirstFrame(t *testing.T) {
	dir := os.Getenv("GALLERY_VIPS_DIR")
	if dir == "" {
		t.Skip("set GALLERY_VIPS_DIR to pinned official DLLs")
	}
	e, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	source := filepath.Join(root, "small.gif")
	target := filepath.Join(root, "s.webp")
	palette := color.Palette{color.RGBA{255, 0, 0, 255}, color.RGBA{0, 0, 255, 255}}
	first := image.NewPaletted(image.Rect(0, 0, 48, 32), palette)
	second := image.NewPaletted(image.Rect(0, 0, 48, 32), palette)
	for i := range second.Pix {
		second.Pix[i] = 1
	}
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	err = gif.EncodeAll(f, &gif.GIF{Image: []*image.Paletted{first, second}, Delay: []int{10, 10}})
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	preview, err := e.Render(source, target, "s", false)
	if err != nil || preview.Original || !preview.Animated {
		t.Fatalf("first frame: %+v %v", preview, err)
	}
	w, h, pages, err := e.imageInfo(target)
	if err != nil || w != 48 || h != 32 || pages != 1 {
		t.Fatal(w, h, pages, err)
	}
}

func TestNativeVipsThumbnailAndPlaceholder(t *testing.T) {
	dir := os.Getenv("GALLERY_VIPS_DIR")
	if dir == "" {
		t.Skip("set GALLERY_VIPS_DIR to pinned official DLLs")
	}
	e, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	source := filepath.Join(root, "合成-source.jpg")
	target := filepath.Join(root, "s.webp")
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 1600, 1200))
	for y := 0; y < 1200; y++ {
		for x := 0; x < 1600; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 255), uint8(y % 255), 120, 255})
		}
	}
	if err = jpeg.Encode(f, img, nil); err != nil {
		t.Fatal(err)
	}
	f.Close()
	p, err := e.Render(source, target, "s", false)
	if err != nil {
		t.Fatal(err)
	}
	if p.Width != 1600 || p.Height != 1200 || len(p.Hash) < 15 || len(p.Hash) > 40 || p.Original {
		t.Fatalf("preview %+v", p)
	}
	w, h, err := e.dimensions(target)
	if err != nil || w != 480 || h != 360 {
		t.Fatal(w, h, err)
	}
	if _, err = e.Render(source+".missing", target, "s", false); err == nil || !strings.Contains(err.Error(), "libvips") {
		t.Fatal("native error buffer was not copied", err)
	}
}
