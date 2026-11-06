package httpservice

import (
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/webui"
)

func (s *Server) frontendFile(name string) ([]byte, error) {
	files := webui.Files()
	if s.options.Frontend != "" {
		files = os.DirFS(s.options.Frontend) // explicit development/oracle fixtures only
	}
	return fs.ReadFile(files, name)
}

func decodePath(value string) (string, error) {
	decoded, err := url.PathUnescape(value)
	if err != nil || !utf8.ValidString(decoded) {
		return "", media.Failure("INVALID_URL", 400)
	}
	return decoded, nil
}

func bytesResponse(w http.ResponseWriter, r *http.Request, status int, b []byte) error {
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(status)
	if r.Method != "HEAD" {
		_, err := w.Write(b)
		return err
	}
	return nil
}
func (s *Server) static(w http.ResponseWriter, r *http.Request, p string) error {
	if p == "/venera-source.js" {
		b, err := s.frontendFile("venera/source.js")
		if err != nil {
			return err
		}
		ids := []string{}
		for _, v := range s.data.Config.Platforms {
			ids = append(ids, v.ID)
		}
		platforms, err := protocol.JSON(ids)
		if err != nil {
			return err
		}
		source := strings.ReplaceAll(string(b), "{{HOST_URL}}", s.data.Config.PublicURL)
		source = strings.Replace(source, "{{PLATFORMS}}", protocol.Component(string(platforms)), 1)
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		if r.Method == "HEAD" {
			w.WriteHeader(200)
			return nil
		}
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		_, err = w.Write([]byte(source))
		return err
	}
	if strings.HasPrefix(p, "/s/") {
		target, err := s.links.resolve(strings.TrimPrefix(p, "/s/"))
		if err != nil {
			return err
		}
		if target == "" {
			return media.Failure("SHORT_LINK_NOT_FOUND", 404)
		}
		w.Header().Set("Location", target)
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != "HEAD" {
			w.Header()["Content-Length"] = nil
		}
		w.WriteHeader(302)
		if r.Method != "HEAD" {
			w.(http.Flusher).Flush()
		}
		return nil
	}
	if p == "/robots.txt" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		return bytesResponse(w, r, 200, []byte("User-agent: *\nDisallow: /\n"))
	}
	var target string
	var b []byte
	var err error
	switch {
	case p == "/":
		target = "index.html"
		b, err = s.frontendFile(target)
	case p == "/protocol/protocol.json":
		b = api.ProtocolJSON
		target = "protocol.json"
	case strings.HasPrefix(p, "/frontend/"):
		rel := strings.TrimPrefix(p, "/frontend/")
		if rel == "gallery/index.html" || rel == "manager/index.html" {
			rel = "index.html"
		}
		rel, err = decodePath(rel)
		if err != nil {
			return media.Failure("INVALID_URL", 400)
		}
		if !fs.ValidPath(rel) || strings.Contains(rel, `\`) {
			return media.Failure("NOT_FOUND", 404)
		}
		if strings.HasPrefix(rel, "assets/canvas/") {
			root := s.options.Assets
			target = filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(rel, "assets/canvas/")))
			if root == "" || !library.Inside(root, target) || filepath.Clean(root) == target {
				return media.Failure("NOT_FOUND", 404)
			}
		} else {
			target = rel
			b, err = s.frontendFile(rel)
		}
	default:
		return media.Failure("NOT_FOUND", 404)
	}
	if err != nil {
		if os.IsNotExist(err) {
			return media.Failure("NOT_FOUND", 404)
		}
		return err
	}
	if b == nil {
		st, e := os.Stat(target)
		if e != nil || !st.Mode().IsRegular() {
			return media.Failure("NOT_FOUND", 404)
		}
		b, err = os.ReadFile(target)
		if err != nil {
			return err
		}
	}
	if filepath.Ext(target) == ".html" {
		w.Header().Set("Content-Security-Policy", api.BrowserCSP)
		b = []byte(strings.Replace(string(b), "<head>", `<head><base href="/frontend/">`, 1))
	}
	types := map[string]string{".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml"}
	kind := types[filepath.Ext(target)]
	if kind == "" {
		kind = "application/octet-stream"
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
	if strings.HasPrefix(p, "/frontend/assets/canvas/") {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	}
	return bytesResponse(w, r, 200, b)
}
