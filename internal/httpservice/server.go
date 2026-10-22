// Package httpservice exposes the public read protocol. It never starts a
// scanner, claims runtime ownership, or creates a Catalog database.
package httpservice

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/dataset"
	"github.com/RecRivenVI/Gallery-Legacy/internal/fileview"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
	"github.com/gorilla/websocket"
)

type Options struct {
	Frontend, Assets string
	Status           func() reading.Row
}
type Server struct {
	data     *dataset.Dataset
	files    *fileview.Browser
	media    *media.Service
	links    *shortLinks
	access   *access
	options  Options
	mu       sync.Mutex
	dataGate sync.RWMutex
	closed   bool
	sockets  map[*websocket.Conn]context.CancelFunc
	streams  sync.WaitGroup
	version  int
}

// New takes ownership of data after a successful return. The caller must close
// the HTTP listener and drain requests before calling Close.
func New(data *dataset.Dataset, options Options) (*Server, error) {
	contract, err := api.Load()
	if err != nil {
		return nil, err
	}
	m, err := media.New(data.Config)
	if err != nil {
		return nil, err
	}
	s := &Server{data: data, files: &fileview.Browser{Config: data.Config}, media: m, options: options, sockets: map[*websocket.Conn]context.CancelFunc{}, version: contract.Version}
	s.links, err = newShortLinks(filepath.Join(data.Config.StateRoot, "short-links"), data.Config.ShortLinks)
	if err != nil {
		m.Close()
		return nil, err
	}
	s.access, err = newAccess(data.Config, time.Now)
	if err != nil {
		m.Close()
		return nil, err
	}
	return s, nil
}
func (s *Server) Close() error {
	s.mu.Lock()
	s.closed = true
	for c, cancel := range s.sockets {
		cancel()
		c.Close()
	}
	s.mu.Unlock()
	s.streams.Wait()
	return errors.Join(s.media.Close(), s.access.close(), s.data.Close())
}
func (s *Server) boundary(r *http.Request) error {
	allowed := func(values []string, value string) bool {
		for _, v := range values {
			if v == value {
				return true
			}
		}
		return false
	}
	if !allowed(s.data.Config.AllowedHosts, strings.ToLower(r.Host)) {
		return media.Failure("HOST_FORBIDDEN", 403)
	}
	if o := r.Header.Get("Origin"); o != "" && !allowed(s.data.Config.AllowedOrigins, o) {
		return media.Failure("ORIGIN_FORBIDDEN", 403)
	}
	return nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		s.events(w, r)
		return
	}
	s.dataGate.RLock()
	defer s.dataGate.RUnlock()
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet")
	allowed, finish := s.access.begin(r)
	tracked := &responseWriter{ResponseWriter: w, status: 200}
	defer func() {
		length, _ := strconv.ParseInt(tracked.Header().Get("Content-Length"), 10, 64)
		finish(tracked.status, length)
	}()
	w = tracked
	if !allowed {
		s.failure(w, r, media.Failure("CLIENT_BLOCKED", 403))
		return
	}
	if err := s.boundary(r); err != nil {
		s.failure(w, r, err)
		return
	}
	if o := r.Header.Get("Origin"); o != "" && o != "http://"+r.Host {
		w.Header().Set("Access-Control-Allow-Origin", o)
		w.Header().Set("Vary", "Origin")
	}
	if err := s.route(w, r); err != nil {
		if !tracked.written {
			s.failure(w, r, err)
			return
		}
		connection, _, closeErr := http.NewResponseController(w).Hijack()
		if closeErr == nil {
			connection.Close()
		} else {
			slog.Error("public response interrupted", "error", err)
		}
	}
}

type responseWriter struct {
	http.ResponseWriter
	status  int
	written bool
}

func (w *responseWriter) WriteHeader(status int) {
	w.status = status
	w.written = true
	w.ResponseWriter.WriteHeader(status)
}
func (w *responseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (s *Server) envelope(ctx context.Context, data reading.Row) reading.Row {
	result := reading.Row{"protocolVersion": s.version, "generationId": s.data.Epoch}
	if s.data.Live && s.data.Reader != nil {
		v, err := s.data.Reader.Snapshot(ctx, func(v *reading.View) (any, error) { return v.LiveState() })
		if err == nil {
			result["revision"] = v.(catalog.LiveState).Revision
		}
	}
	for k, v := range data {
		result[k] = v
	}
	return result
}
func (s *Server) send(w http.ResponseWriter, r *http.Request, data any, revision *int64) error {
	result := reading.Row{"protocolVersion": s.version, "generationId": s.data.Epoch, "data": data}
	if revision != nil {
		result["revision"] = *revision
	} else {
		result = s.envelope(r.Context(), reading.Row{"data": data})
	}
	return jsonResponse(w, r, 200, result, true)
}
func jsonResponse(w http.ResponseWriter, r *http.Request, status int, data any, secure bool) error {
	b, err := protocol.JSON(data)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if secure {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		return bytesResponse(w, r, status, b)
	}
	w.WriteHeader(status)
	if r.Method != "HEAD" {
		w.(http.Flusher).Flush()
		_, err = w.Write(b)
	}
	return err
}
func (s *Server) failure(w http.ResponseWriter, r *http.Request, err error) {
	code, status, message := "REQUEST_FAILED", 500, "Request could not be completed"
	var e *protocol.Error
	if errors.As(err, &e) {
		code, status, message = e.Code, e.Status, e.Code
	}
	_ = jsonResponse(w, r, status, s.envelope(r.Context(), reading.Row{"error": reading.Row{"code": code, "message": message}}), true)
}
func (s *Server) read(ctx context.Context, fn func(*reading.View) (any, error)) (any, *int64, error) {
	var revision *int64
	if s.data.Reader == nil {
		data, err := fn(nil)
		return data, nil, err
	}
	data, err := s.data.Reader.Snapshot(ctx, func(v *reading.View) (any, error) {
		if s.data.Live {
			state, err := v.LiveState()
			if err != nil {
				return nil, err
			}
			revision = &state.Revision
		}
		return fn(v)
	})
	return data, revision, err
}
func (s *Server) state(ctx context.Context) (reading.Row, error) {
	state, err := s.data.State(ctx)
	if err != nil {
		return nil, err
	}
	result := reading.Row{}
	if s.options.Status != nil {
		for k, v := range s.options.Status() {
			result[k] = v
		}
	}
	result["libraryReady"], result["counts"] = state["libraryReady"], state["counts"]
	stats := state["platformStats"].([]reading.Row)
	platforms := []reading.Row{}
	for _, p := range s.data.Config.Platforms {
		row := reading.Row{"id": p.ID, "family": p.Family, "adapterVersion": p.AdapterVersion}
		for _, st := range stats {
			if st["id"] == p.ID {
				for k, v := range st {
					row[k] = v
				}
				break
			}
		}
		platforms = append(platforms, row)
	}
	result["platforms"] = platforms
	if st, ok := state["live"]; ok {
		b, err := protocol.JSON(st)
		if err != nil {
			return nil, err
		}
		var live reading.Row
		if err := json.Unmarshal(b, &live); err != nil {
			return nil, err
		}
		live["enabled"] = true
		result["live"] = live
	}
	return result, nil
}

func stateRevision(state reading.Row) *int64 {
	if live, ok := state["live"].(map[string]any); ok {
		revision := count(live["revision"])
		return &revision
	}
	return nil
}
