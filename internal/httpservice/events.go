package httpservice

import (
	"context"
	"net/http"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
	"github.com/gorilla/websocket"
)

func destroy(w http.ResponseWriter) {
	if h, ok := w.(http.Hijacker); ok {
		if c, _, err := h.Hijack(); err == nil {
			c.Close()
		}
	}
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	if err := s.boundary(r); err != nil || r.URL.EscapedPath() != "/api/v1/events" {
		destroy(w)
		return
	}
	u := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	c, err := u.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	// Match the frozen Node ws receiver limit; incoming messages grant no control.
	c.SetReadLimit(100 * 1024 * 1024)
	ctx, cancel := context.WithCancel(r.Context())
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		cancel()
		c.Close()
		return
	}
	s.sockets[c] = cancel
	s.streams.Add(1)
	s.mu.Unlock()
	defer func() {
		cancel()
		c.Close()
		s.mu.Lock()
		delete(s.sockets, c)
		s.mu.Unlock()
		s.streams.Done()
	}()
	go func() {
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()
	send := func() error {
		data, err := s.state(ctx)
		if err != nil {
			return err
		}
		b, err := protocol.JSON(reading.Row{"protocolVersion": s.version, "type": "status", "data": data})
		if err != nil {
			return err
		}
		return c.WriteMessage(websocket.TextMessage, b)
	}
	if err = send(); err != nil {
		_ = c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1011, ""), time.Now().Add(time.Second))
		return
	}
	timer := time.NewTicker(1500 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if err = send(); err != nil {
				return
			}
		}
	}
}
