package media

import (
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

var mime = map[string]string{".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".tif": "image/tiff", ".tiff": "image/tiff", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ogv": "video/ogg"}
var rangePattern = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

func MIME(path string) string {
	if v := mime[strings.ToLower(filepath.Ext(path))]; v != "" {
		return v
	}
	return "application/octet-stream"
}

func Range(value string, size int64) (int64, int64, int, error) {
	start, end, status := int64(0), size-1, 200
	if value == "" {
		return start, end, status, nil
	}
	m := rangePattern.FindStringSubmatch(value)
	if m == nil || m[1] == "" && m[2] == "" {
		return 0, 0, 0, Failure("INVALID_RANGE", 416)
	}
	parse := func(s string) *big.Int { n, _ := new(big.Int).SetString(s, 10); return n }
	limit := big.NewInt(size)
	if m[1] == "" {
		n := parse(m[2])
		if n.Sign() <= 0 {
			return 0, 0, 0, Failure("INVALID_RANGE", 416)
		}
		if n.Cmp(limit) < 0 {
			start = size - n.Int64()
		}
	} else {
		n := parse(m[1])
		if n.Cmp(limit) >= 0 {
			return 0, 0, 0, Failure("INVALID_RANGE", 416)
		}
		start = n.Int64()
		if m[2] != "" {
			n = parse(m[2])
			if n.Cmp(big.NewInt(start)) < 0 {
				return 0, 0, 0, Failure("INVALID_RANGE", 416)
			}
			if n.Cmp(limit) < 0 {
				end = n.Int64()
			}
		}
	}
	if start >= size || end < start {
		return 0, 0, 0, Failure("INVALID_RANGE", 416)
	}
	return start, end, 206, nil
}

func Stream(w http.ResponseWriter, r *http.Request, f File, contentType string, headers map[string]string) error {
	if f.Info.Size() > 9007199254740991 {
		return Failure("MEDIA_SIZE_UNSUPPORTED", 422)
	}
	start, end, status, err := Range(r.Header.Get("Range"), f.Info.Size())
	if err != nil {
		return err
	}
	if err = library.NoLinks(f.Path); err != nil {
		return err
	}
	input, err := os.Open(f.Path)
	if err != nil {
		return err
	}
	defer input.Close()
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(max(0, end-start+1), 10))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "private, max-age=0")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if status == 206 {
		w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(f.Info.Size(), 10))
	}
	if contentType == "image/svg+xml" {
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
	}
	for key, value := range headers {
		w.Header().Set(key, value)
	}
	w.WriteHeader(status)
	if r.Method == "HEAD" || f.Info.Size() == 0 {
		return nil
	}
	_, err = io.Copy(w, io.NewSectionReader(input, start, end-start+1))
	return err
}
func Subtitle(f File, lang string) (File, error) {
	if lang != "zh-CN" && lang != "en-US" || f.Kind != "video" {
		return f, Failure("SUBTITLE_INVALID", 400)
	}
	f.Path = strings.TrimSuffix(f.Path, filepath.Ext(f.Path)) + "." + lang + ".vtt"
	if err := library.NoLinks(f.Path); err != nil {
		return f, Failure("SUBTITLE_NOT_FOUND", 404)
	}
	var err error
	f.Info, err = os.Lstat(f.Path)
	if err != nil {
		return f, Failure("SUBTITLE_NOT_FOUND", 404)
	}
	if !f.Info.Mode().IsRegular() || f.Info.Size() > 4<<20 {
		return f, Failure("SUBTITLE_UNAVAILABLE", 404)
	}
	return f, nil
}
