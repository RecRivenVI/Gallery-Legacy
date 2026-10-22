package httpservice

import (
	"encoding/json"
	"io"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/fileview"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func body(r *http.Request) (reading.Row, error) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil {
		return nil, media.Failure("INVALID_BODY", 400)
	}
	if len(b) > 4096 {
		return nil, media.Failure("BODY_TOO_LARGE", 413)
	}
	var value any
	if err = json.Unmarshal(b, &value); err != nil {
		return nil, media.Failure("INVALID_JSON", 400)
	}
	row, _ := value.(map[string]any)
	return row, nil
}
func value(q url.Values, key, fallback string) string {
	if s := q.Get(key); s != "" {
		return s
	}
	return fallback
}
func number(s string) float64 {
	s = protocol.TrimSpace(s)
	var n float64
	var err error
	if len(s) > 2 && (strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") || strings.HasPrefix(s, "0b") || strings.HasPrefix(s, "0B") || strings.HasPrefix(s, "0o") || strings.HasPrefix(s, "0O")) {
		integer, ok := new(big.Int).SetString(s, 0)
		if !ok || strings.ContainsRune(s, '_') {
			return 0
		}
		n, _ = integer.Float64()
	} else {
		n, err = strconv.ParseFloat(s, 64)
	}
	if err != nil || strings.ContainsRune(s, '_') || math.IsInf(n, 0) || math.IsNaN(n) || n != math.Trunc(n) || n < 1 {
		return 0
	}
	return n
}
func fileOptions(q url.Values, search bool) fileview.Options {
	size := "100"
	if search {
		size = "48"
	}
	pageSize := number(value(q, "pageSize", size))
	if pageSize > 500 {
		pageSize = 0
	}
	return fileview.Options{Page: number(value(q, "page", "1")), Size: int(pageSize), Filter: value(q, "mediaType", "all"), Order: value(q, "order", "asc")}
}
func (s *Server) route(w http.ResponseWriter, r *http.Request) error {
	p := r.URL.EscapedPath()
	q := protocol.Parameters(r.URL.RawQuery)
	if r.Method == "OPTIONS" {
		if m := r.Header.Get("Access-Control-Request-Method"); m != "GET" && m != "HEAD" {
			return media.Failure("METHOD_NOT_ALLOWED", 405)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD")
		w.Header().Set("Access-Control-Allow-Headers", "Range, cache-time")
		w.WriteHeader(204)
		return nil
	}
	if !strings.HasPrefix(p, "/api/") {
		if r.Method != "GET" && r.Method != "HEAD" {
			return media.Failure("METHOD_NOT_ALLOWED", 405)
		}
		return s.static(w, r, p)
	}
	if (p == "/api/shorten" || p == "/api/v1/short-links") && r.Method == "POST" {
		input, err := body(r)
		if err != nil {
			return err
		}
		data, revision, err := s.read(r.Context(), func(v *reading.View) (any, error) { return s.links.create(input, v, s.files) })
		if err != nil {
			return err
		}
		if p == "/api/shorten" {
			return jsonResponse(w, r, 200, data, false)
		}
		return s.send(w, r, data, revision)
	}
	if !strings.HasPrefix(p, "/api/v1/") {
		handled, err := s.legacy(w, r, p, q)
		if handled || err != nil {
			return err
		}
	}
	if r.Method == "GET" {
		switch p {
		case "/api/v1/health":
			contract, err := api.LoadCatalog()
			if err != nil {
				return err
			}
			return s.send(w, r, reading.Row{"ready": s.data.Generation != nil, "instanceId": s.data.Config.InstanceID, "schemaVersion": contract.SchemaVersion, "searchVersion": contract.SearchVersion}, nil)
		case "/api/v1/status", "/api/v1/platforms":
			state, err := s.state(r.Context())
			if err != nil {
				return err
			}
			if p == "/api/v1/platforms" {
				return s.send(w, r, reading.Row{"items": state["platforms"]}, stateRevision(state))
			}
			state["localControl"] = false
			return s.send(w, r, state, stateRevision(state))
		case "/api/v1/file-roots":
			return s.send(w, r, reading.Row{"items": s.files.Roots()}, nil)
		case "/api/v1/files", "/api/v1/file-search":
			var data reading.Row
			var err error
			if p == "/api/v1/files" {
				data, err = s.files.List(q.Get("root"), q.Get("path"), fileOptions(q, false))
			} else {
				data, err = s.files.Search(r.Context(), q.Get("root"), q.Get("path"), q.Get("q"), fileOptions(q, true))
			}
			if err != nil {
				return err
			}
			return s.send(w, r, data, nil)
		case "/api/v1/generations":
			items := any([]any{})
			if s.options.Status != nil {
				if v, ok := s.options.Status()["generations"]; ok {
					items = v
				}
			}
			return s.send(w, r, reading.Row{"items": items}, nil)
		case "/api/v1/works", "/api/v1/authors", "/api/v1/tags":
			data, err := s.data.Page(r.Context(), strings.TrimPrefix(p, "/api/v1/"), q)
			if err != nil {
				return err
			}
			revision, _ := data["revision"].(*int64)
			return s.send(w, r, data, revision)
		case "/api/v1/resolve", "/api/v1/chapters":
			return s.resolve(w, r, p, q)
		}
		if strings.HasPrefix(p, "/api/v1/works/") && len(p) > len("/api/v1/works/") && !strings.Contains(p[len("/api/v1/works/"):], "/") {
			return s.work(w, r, p, q)
		}
	}
	if r.Method == "GET" || r.Method == "HEAD" {
		if p == "/api/v1/file-media" || p == "/api/v1/file-thumbnails" || p == "/api/v1/file-subtitles" {
			f, err := s.files.Media(q.Get("root"), q.Get("path"))
			if err != nil {
				return err
			}
			return s.serveMedia(w, r, f, p == "/api/v1/file-thumbnails", p == "/api/v1/file-subtitles", q.Get("lang"))
		}
		parts := strings.Split(strings.TrimPrefix(p, "/api/v1/"), "/")
		if len(parts) == 2 && parts[1] != "" && (parts[0] == "media" || parts[0] == "thumbnails" || parts[0] == "subtitles") {
			return s.libraryMedia(w, r, parts[0], parts[1], q)
		}
	}
	if p == "/api/v1/scans" && r.Method == "POST" {
		input, err := body(r)
		if err != nil {
			return err
		}
		if input["confirmReadOnly"] != true {
			return media.Failure("READ_ONLY_CONFIRMATION_REQUIRED", 400)
		}
		return media.Failure("LOCAL_CONTROL_REQUIRED", 403)
	}
	return media.Failure("ENDPOINT_NOT_FOUND", 404)
}
func (s *Server) serveMedia(w http.ResponseWriter, r *http.Request, f media.File, thumbnail, subtitle bool, lang string) error {
	headers := map[string]string{}
	kind := media.MIME(f.Path)
	if subtitle {
		var err error
		f, err = media.Subtitle(f, lang)
		if err != nil {
			return err
		}
		kind = "text/vtt; charset=utf-8"
	}
	if thumbnail {
		var err error
		var status string
		f, status, err = s.media.Thumbnail(r.Context(), f)
		if err != nil {
			return err
		}
		headers["X-Gallery-Thumbnail"] = status
		kind = "image/webp"
	}
	return media.Stream(w, r, f, kind, headers)
}
