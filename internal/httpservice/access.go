package httpservice

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

// Access history is not authorization: it can refuse a blocked public client,
// but no address (including localhost) grants management operations.
type access struct {
	mu             sync.Mutex
	file, id       string
	enabled, dirty bool
	clients        []reading.Row
	events         []reading.Row
	now            func() time.Time
	stop           chan struct{}
	done           chan struct{}
}

func clientID(instance, ip string) string {
	h := sha256.Sum256([]byte(instance + "\x00" + ip))
	return hex.EncodeToString(h[:])[:16]
}
func local(ip string) bool {
	if ip == "127.0.0.1" || ip == "::1" || ip == "::ffff:127.0.0.1" {
		return true
	}
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addresses {
		host, _, err := net.ParseCIDR(a.String())
		if err == nil && host.String() == ip {
			return true
		}
	}
	return false
}
func count(value any) int64 {
	switch n := value.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		if n >= 0 && n <= 9007199254740991 && n == float64(int64(n)) {
			return int64(n)
		}
	}
	return 0
}
func today(t time.Time) int64 {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / 86400
}
func validDays(value any, day int64) reading.Row {
	result := reading.Row{}
	if rows, ok := value.(map[string]any); ok {
		for k, v := range rows {
			d, err := strconv.ParseInt(k, 10, 64)
			if err != nil || d < day-30 || d > day {
				continue
			}
			row, ok := v.(map[string]any)
			if !ok {
				continue
			}
			requests, errors := count(row["requests"]), count(row["errors"])
			if requests == 0 && row["requests"] != float64(0) && row["requests"] != int64(0) {
				continue
			}
			if errors == 0 && row["errors"] != float64(0) && row["errors"] != int64(0) {
				continue
			}
			result[k] = row
		}
	}
	return result
}
func newAccess(config instance.Config, now func() time.Time) (*access, error) {
	a := &access{file: filepath.Join(config.StateRoot, "access-history.json"), id: config.InstanceID, enabled: true, clients: []reading.Row{}, events: []reading.Row{}, now: now, stop: make(chan struct{}), done: make(chan struct{})}
	if err := library.NoLinks(a.file); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(a.file)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	var saved struct {
		Version         int
		InstanceID      string
		Enabled         *bool
		Clients, Events []reading.Row
	}
	if json.Unmarshal(b, &saved) == nil && saved.Version == 1 && saved.InstanceID == a.id {
		if saved.Enabled != nil {
			a.enabled = *saved.Enabled
		}
		for _, c := range saved.Clients[max(0, len(saved.Clients)-256):] {
			ip, ok := c["address"].(string)
			if !ok || len(ip) > 64 || c["id"] != clientID(a.id, ip) || count(c["lastSeenAtMs"]) < a.now().Add(-30*24*time.Hour).UnixMilli() {
				continue
			}
			c = reading.Row{"id": c["id"], "address": ip, "agent": c["agent"], "blocked": c["blocked"], "days": c["days"], "requests": c["requests"], "errors": c["errors"], "bytes": c["bytes"], "lastSeenAtMs": c["lastSeenAtMs"]}
			c["local"], c["active"] = local(ip), int64(0)
			c["blocked"] = !local(ip) && c["blocked"] == true
			if !slices.Contains([]string{"Browser", "Venera", "Other"}, stringValue(c["agent"])) {
				c["agent"] = "Other"
			}
			for _, k := range []string{"requests", "errors", "bytes", "lastSeenAtMs"} {
				c[k] = count(c[k])
			}
			c["days"] = validDays(c["days"], today(a.now()))
			a.clients = append(a.clients, c)
		}
		category := regexp.MustCompile(`^[a-z-]+$`)
		for _, e := range saved.Events[max(0, len(saved.Events)-200):] {
			client := false
			for _, c := range a.clients {
				if c["id"] == e["client"] {
					client = true
					break
				}
			}
			if client && category.MatchString(stringValue(e["resource"])) && slices.Contains([]string{"GET", "HEAD", "POST", "OPTIONS"}, stringValue(e["method"])) {
				a.events = append(a.events, reading.Row{"client": e["client"], "resource": e["resource"], "method": e["method"], "status": e["status"], "atMs": e["atMs"], "elapsedMs": count(e["elapsedMs"])})
			}
		}
	}
	go func() {
		defer close(a.done)
		timer := time.NewTicker(5 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-a.stop:
				return
			case <-timer.C:
				if err := a.flush(); err != nil {
					slog.Error("access history flush", "error", err)
				}
			}
		}
	}()
	return a, nil
}
func stringValue(v any) string { s, _ := v.(string); return s }
func category(p string) string {
	for _, k := range []string{"media", "thumbnails", "works", "authors", "tags", "files", "status", "health"} {
		if strings.HasPrefix(p, "/api/v1/"+k) {
			return k
		}
	}
	if p == "/venera-source.js" {
		return "venera-source"
	}
	if strings.HasPrefix(p, "/api/") {
		return "other-api"
	}
	return "page-or-asset"
}
func (a *access) begin(r *http.Request) (bool, func(int, int64)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if ip == "" {
		ip = "unknown"
	}
	id := clientID(a.id, ip)
	var client reading.Row
	for _, c := range a.clients {
		if c["id"] == id {
			client = c
			break
		}
	}
	if client == nil {
		if len(a.clients) >= 256 {
			old := -1
			for i, c := range a.clients {
				if count(c["active"]) == 0 && c["blocked"] != true && (old < 0 || count(c["lastSeenAtMs"]) < count(a.clients[old]["lastSeenAtMs"])) {
					old = i
				}
			}
			if old < 0 {
				return false, func(int, int64) {}
			}
			a.clients = slices.Delete(a.clients, old, old+1)
		}
		agent := "Other"
		ua := strings.ToLower(r.UserAgent())
		if strings.Contains(ua, "venera") {
			agent = "Venera"
		} else if strings.Contains(ua, "mozilla") {
			agent = "Browser"
		}
		client = reading.Row{"id": id, "address": ip, "local": local(ip), "agent": agent, "requests": int64(0), "errors": int64(0), "active": int64(0), "bytes": int64(0), "blocked": false, "lastSeenAtMs": int64(0), "days": reading.Row{}}
		a.clients = append(a.clients, client)
	}
	day := strconv.FormatInt(today(a.now()), 10)
	days := client["days"].(map[string]any)
	counter, ok := days[day].(map[string]any)
	if !ok {
		counter = reading.Row{"requests": int64(0), "errors": int64(0)}
		days[day] = counter
	}
	counter["requests"] = count(counter["requests"]) + 1
	client["requests"] = count(client["requests"]) + 1
	client["active"] = count(client["active"]) + 1
	client["lastSeenAtMs"] = a.now().UnixMilli()
	a.dirty = true
	started := time.Now()
	return !a.enabled || client["blocked"] != true, func(status int, bytes int64) {
		a.mu.Lock()
		defer a.mu.Unlock()
		client["active"] = count(client["active"]) - 1
		client["lastSeenAtMs"] = a.now().UnixMilli()
		if status >= 400 {
			client["errors"] = count(client["errors"]) + 1
			counter["errors"] = count(counter["errors"]) + 1
		}
		client["bytes"] = count(client["bytes"]) + bytes
		a.events = append(a.events, reading.Row{"atMs": a.now().UnixMilli(), "client": id, "method": r.Method, "resource": category(r.URL.Path), "status": status, "elapsedMs": time.Since(started).Milliseconds()})
		if len(a.events) > 200 {
			a.events = a.events[1:]
		}
		a.dirty = true
	}
}
func (a *access) flush() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	day := today(a.now())
	a.clients = slices.DeleteFunc(a.clients, func(c reading.Row) bool {
		c["days"] = validDays(c["days"], day)
		if count(c["active"]) == 0 && count(c["lastSeenAtMs"]) < a.now().Add(-30*24*time.Hour).UnixMilli() {
			a.dirty = true
			return true
		}
		return false
	})
	a.events = slices.DeleteFunc(a.events, func(e reading.Row) bool {
		for _, c := range a.clients {
			if c["id"] == e["client"] {
				return false
			}
		}
		a.dirty = true
		return true
	})
	if !a.dirty {
		return nil
	}
	clients := []reading.Row{}
	for _, c := range a.clients {
		row := reading.Row{}
		for k, v := range c {
			row[k] = v
		}
		row["active"] = 0
		clients = append(clients, row)
	}
	if err := instance.WriteJSON(a.file, reading.Row{"version": 1, "instanceId": a.id, "enabled": a.enabled, "clients": clients, "events": a.events}); err != nil {
		return err
	}
	a.dirty = false
	return nil
}
func (a *access) close() error { close(a.stop); <-a.done; return a.flush() }
