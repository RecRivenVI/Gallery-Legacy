// Package imaging owns the small libvips C-ABI surface used by thumbnails.
package imaging

import (
	"bytes"
	"fmt"
	"image/png"
	"math"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"go.n16f.net/thumbhash"
	"golang.org/x/sys/windows"
)

type Engine struct {
	init, header, width, height, swap, thumbnail, thumbnailImage *windows.Proc
	webp, png, unref, free, errorBuffer, errorClear              *windows.Proc
	pages                                                        *windows.Proc
	strlcpy                                                      *windows.Proc
}

type Preview struct {
	DurationMs    int64
	Width, Height int
	Hash          []byte
	Original      bool
	Animated      bool
}

func Load(directory string) (*Engine, error) {
	load := func(name string) (*windows.DLL, error) {
		h, err := windows.LoadLibraryEx(filepath.Join(directory, name), 0, windows.LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|windows.LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
		if err != nil {
			return nil, fmt.Errorf("load %s: %w", name, err)
		}
		// DLLs live with the process; libvips keeps global worker/TLS state.
		return &windows.DLL{Name: name, Handle: h}, nil
	}
	vips, err := load("libvips-42.dll")
	if err != nil {
		return nil, err
	}
	object, err := load("libgobject-2.0-0.dll")
	if err != nil {
		return nil, err
	}
	glib, err := load("libglib-2.0-0.dll")
	if err != nil {
		return nil, err
	}
	e := &Engine{}
	for _, binding := range []struct {
		dll  *windows.DLL
		name string
		proc **windows.Proc
	}{
		{vips, "vips_init", &e.init}, {vips, "vips_image_new_from_file", &e.header},
		{vips, "vips_image_get_width", &e.width}, {vips, "vips_image_get_height", &e.height},
		{vips, "vips_image_get_orientation_swap", &e.swap}, {vips, "vips_thumbnail", &e.thumbnail},
		{vips, "vips_image_get_n_pages", &e.pages},
		{vips, "vips_thumbnail_image", &e.thumbnailImage}, {vips, "vips_webpsave", &e.webp},
		{vips, "vips_pngsave_buffer", &e.png}, {vips, "vips_error_buffer", &e.errorBuffer},
		{vips, "vips_error_clear", &e.errorClear}, {object, "g_object_unref", &e.unref}, {glib, "g_free", &e.free},
		{glib, "g_strlcpy", &e.strlcpy},
	} {
		*binding.proc, err = binding.dll.FindProc(binding.name)
		if err != nil {
			return nil, fmt.Errorf("bind %s: %w", binding.name, err)
		}
	}
	name, _ := windows.BytePtrFromString("Gallery")
	if code, _, _ := e.init.Call(uintptr(unsafe.Pointer(name))); int32(code) != 0 {
		return nil, e.failure("initialize")
	}
	for _, setting := range []struct {
		name  string
		value uintptr
	}{{"vips_concurrency_set", 1}, {"vips_cache_set_max", 0}, {"vips_cache_set_max_mem", 64 << 20}} {
		proc, err := vips.FindProc(setting.name)
		if err != nil {
			return nil, err
		}
		proc.Call(setting.value)
	}
	return e, nil
}

func (e *Engine) failure(action string) error {
	p, _, _ := e.errorBuffer.Call()
	message := ""
	if p != 0 {
		// Copy through GLib instead of converting an integer return register
		// into a Go pointer. The error buffer belongs to this locked OS thread.
		buffer := make([]byte, 1024)
		length, _, _ := e.strlcpy.Call(uintptr(unsafe.Pointer(&buffer[0])), p, uintptr(len(buffer)))
		if length >= uintptr(len(buffer)) {
			buffer = make([]byte, length+1)
			e.strlcpy.Call(uintptr(unsafe.Pointer(&buffer[0])), p, uintptr(len(buffer)))
		}
		message = string(buffer[:length])
		runtime.KeepAlive(buffer)
	}
	e.errorClear.Call()
	return fmt.Errorf("libvips %s: %s", action, message)
}

func (e *Engine) dimensions(path string) (int, int, error) {
	w, h, _, err := e.imageInfo(path)
	return w, h, err
}

func (e *Engine) imageInfo(path string) (int, int, int, error) {
	name, err := windows.BytePtrFromString(path)
	if err != nil {
		return 0, 0, 0, err
	}
	image, _, _ := e.header.Call(uintptr(unsafe.Pointer(name)), 0)
	runtime.KeepAlive(name)
	if image == 0 {
		return 0, 0, 0, e.failure("read header")
	}
	defer e.unref.Call(image)
	w, _, _ := e.width.Call(image)
	h, _, _ := e.height.Call(image)
	swap, _, _ := e.swap.Call(image)
	if swap != 0 {
		w, h = h, w
	}
	pages, _, _ := e.pages.Call(image)
	return int(w), int(h), int(pages), nil
}

func Target(width, height int, tier string) (int, int) {
	scale := 1.0
	switch tier {
	case "display", "strip":
		short, long := 540.0, 1620.0
		if tier == "strip" {
			short, long = 144, 432
		}
		scale = math.Min(short/float64(min(width, height)), long/float64(max(width, height)))
	}
	scale = math.Min(1, scale)
	return max(1, int(math.Round(float64(width)*scale))), max(1, int(math.Round(float64(height)*scale)))
}

func (e *Engine) Render(path, target, tier string, force bool) (Preview, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	w, h, pages, err := e.imageInfo(path)
	if err != nil {
		return Preview{}, err
	}
	tw, th := Target(w, h, tier)
	ext := strings.ToLower(filepath.Ext(path))
	animated := pages > 1 && (ext == ".gif" || ext == ".webp")
	force = force || animated || ext == ".gif" || ext == ".tif" || ext == ".tiff" || ext == ".svg"
	preview := Preview{Width: w, Height: h, Animated: animated, Original: tw == w && th == h && !force}
	name, err := windows.BytePtrFromString(path)
	if err != nil {
		return preview, err
	}
	height, _ := windows.BytePtrFromString("height")
	size, _ := windows.BytePtrFromString("size")
	var image uintptr
	code, _, _ := e.thumbnail.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&image)), uintptr(tw), uintptr(unsafe.Pointer(height)), uintptr(th), uintptr(unsafe.Pointer(size)), 2, 0)
	runtime.KeepAlive(name)
	runtime.KeepAlive(height)
	runtime.KeepAlive(size)
	if int32(code) != 0 {
		return preview, e.failure("thumbnail")
	}
	defer e.unref.Call(image)
	if preview.Original {
		preview.Hash, err = e.hash(image)
		return preview, err
	}
	output, _ := windows.BytePtrFromString(target)
	quality, _ := windows.BytePtrFromString("Q")
	strip, _ := windows.BytePtrFromString("strip")
	effort, _ := windows.BytePtrFromString("effort")
	code, _, _ = e.webp.Call(image, uintptr(unsafe.Pointer(output)), uintptr(unsafe.Pointer(quality)), 82, uintptr(unsafe.Pointer(strip)), 1, uintptr(unsafe.Pointer(effort)), 4, 0)
	runtime.KeepAlive(output)
	runtime.KeepAlive(quality)
	runtime.KeepAlive(strip)
	runtime.KeepAlive(effort)
	if int32(code) != 0 {
		return preview, e.failure("write WebP")
	}
	// A shrink-on-load JPEG graph is sequential. Do not consume it once for
	// the hash and then seek backwards for WebP: hash the small cached output.
	cached, _, _ := e.header.Call(uintptr(unsafe.Pointer(output)), 0)
	runtime.KeepAlive(output)
	if cached == 0 {
		return preview, e.failure("read rendered preview")
	}
	defer e.unref.Call(cached)
	preview.Hash, err = e.hash(cached)
	return preview, err
}

func (e *Engine) hash(image uintptr) ([]byte, error) {
	height, _ := windows.BytePtrFromString("height")
	var small uintptr
	code, _, _ := e.thumbnailImage.Call(image, uintptr(unsafe.Pointer(&small)), 32, uintptr(unsafe.Pointer(height)), 32, 0)
	runtime.KeepAlive(height)
	if int32(code) != 0 {
		return nil, e.failure("placeholder")
	}
	defer e.unref.Call(small)
	var buffer unsafe.Pointer
	var size uintptr
	code, _, _ = e.png.Call(small, uintptr(unsafe.Pointer(&buffer)), uintptr(unsafe.Pointer(&size)), 0)
	if int32(code) != 0 {
		return nil, e.failure("placeholder pixels")
	}
	defer e.free.Call(uintptr(buffer))
	pixels, err := png.Decode(bytes.NewReader(unsafe.Slice((*byte)(buffer), size)))
	if err != nil {
		return nil, fmt.Errorf("decode placeholder pixels: %w", err)
	}
	return thumbhash.EncodeImage(pixels), nil
}
